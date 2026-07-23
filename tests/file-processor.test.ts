import { describe, expect, it, vi } from "vitest";

import { AzureAdapterError } from "../src/infrastructure/azure/azure-document-intelligence-adapter.js";
import type { AnalyzeDocumentOptions } from "../src/infrastructure/azure/azure-document-intelligence-adapter.js";
import type { SupportedMimeType } from "../src/infrastructure/storage/temporary-file-storage.js";
import type {
  BatchRecord,
  FileJobRecord,
} from "../src/modules/jobs/job-repository.js";
import { FileProcessor } from "../src/workers/file-processor.js";
import { MemoryJobRepository } from "./helpers/memory-job-repository.js";

function file(
  id: string,
  sourcePath: string,
  overrides: Partial<FileJobRecord> = {},
): FileJobRecord {
  return {
    file_job_id: id,
    request_id: `request-${id}`,
    client_file_id: `drive-${id}`,
    file_name: `${id}.pdf`,
    language: "id-ID",
    modified_time: null,
    status: "queued",
    result_ready: false,
    source_path: sourcePath,
    mime_type: "application/pdf",
    size_bytes: 10,
    sha256: id.padEnd(64, "a").slice(0, 64),
    ...overrides,
  };
}

async function repositoryWith(files: FileJobRecord[]) {
  const repository = new MemoryJobRepository();
  const batch: BatchRecord = {
    batch_id: "batch-1",
    status: "queued",
    created_at: "2026-07-23T00:00:00.000Z",
    files,
  };
  await repository.store({
    batch,
    idempotencyKey: "test-key",
    requestFingerprint: "fingerprint",
    jobTtlSeconds: 86_400,
    idempotencyTtlSeconds: 86_400,
  });
  return repository;
}

function dependencies(repository: MemoryJobRepository) {
  const preparer = {
    prepare: vi.fn((sourcePath: string) =>
      Promise.resolve({
        sourcePath,
        pageCount: 3,
        parts: [
          {
            partNumber: 1,
            startPage: 1,
            endPage: 2,
            temporaryPath: `${sourcePath}-part-1`,
            sizeBytes: 10,
          },
          {
            partNumber: 2,
            startPage: 3,
            endPage: 3,
            temporaryPath: `${sourcePath}-part-2`,
            sizeBytes: 10,
          },
        ],
      }),
    ),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  const storage = {
    read: vi.fn((path: string) => Promise.resolve(Buffer.from(path))),
  };
  const azure = {
    analyze: vi.fn(
      (
        document: Uint8Array,
        mimeType: SupportedMimeType,
        options?: AnalyzeDocumentOptions,
      ) => {
        void document;
        void mimeType;
        void options;
        const path = Buffer.from(document).toString();
        return Promise.resolve({
          pages: path.includes("part-2")
            ? [
                {
                  pageNumber: 1,
                  lines: [{ content: "Page three" }],
                  words: [{ content: "three", confidence: 0.8 }],
                },
              ]
            : [
                {
                  pageNumber: 1,
                  lines: [{ content: "Page one" }],
                  words: [{ content: "one", confidence: 1 }],
                },
                {
                  pageNumber: 2,
                  lines: [{ content: "Page two" }],
                  words: [{ content: "two", confidence: 0.5 }],
                },
              ],
          tables: [],
        });
      },
    ),
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  return { repository, preparer, storage, azure, logger };
}

describe("file processor", () => {
  it("stores a validated final result and cleans temporary data", async () => {
    const repository = await repositoryWith([file("file-1", "/tmp/source-1")]);
    const deps = dependencies(repository);
    deps.azure.analyze.mockImplementation(
      async (
        _document: Uint8Array,
        _mimeType: SupportedMimeType,
        options?: AnalyzeDocumentOptions,
      ) => {
        await options?.onSubmitted?.(
          "https://sample.test/documentintelligence/documentModels/prebuilt-layout/analyzeResults/saved?api-version=2024-11-30",
        );
        await options?.onRetry?.(2);
        const path = Buffer.from(_document).toString();
        return {
          pages: path.includes("part-2")
            ? [
                {
                  pageNumber: 1,
                  lines: [{ content: "Page three" }],
                  words: [],
                },
              ]
            : [
                {
                  pageNumber: 1,
                  lines: [{ content: "Page one" }],
                  words: [],
                },
                {
                  pageNumber: 2,
                  lines: [{ content: "Page two" }],
                  words: [],
                },
              ],
          tables: [],
        };
      },
    );
    const progress: number[] = [];
    const processor = new FileProcessor(deps);

    await processor.process(
      { batchId: "batch-1", fileJobId: "file-1" },
      (value) => {
        progress.push(value);
        return Promise.resolve();
      },
    );

    const updated = await repository.get("batch-1");
    expect(updated?.files[0]).toMatchObject({
      status: "success",
      result_ready: true,
      page_count: 3,
      result: {
        client_file_id: "drive-file-1",
        status: "success",
        document: {
          file_name: "file-1.pdf",
          language: "id-ID",
          page_count: 3,
        },
        data: {
          text: "Page one\n\nPage two\n\nPage three",
          tables: [],
        },
        confidence: null,
      },
      parts: [
        {
          part_number: 1,
          start_page: 1,
          end_page: 2,
          azure_status: "succeeded",
          retry_count: 2,
          operation_location:
            "https://sample.test/documentintelligence/documentModels/prebuilt-layout/analyzeResults/saved?api-version=2024-11-30",
          azure_result: { pages: [{ pageNumber: 1 }, { pageNumber: 2 }] },
        },
        {
          part_number: 2,
          start_page: 3,
          end_page: 3,
          azure_status: "succeeded",
          retry_count: 2,
          operation_location:
            "https://sample.test/documentintelligence/documentModels/prebuilt-layout/analyzeResults/saved?api-version=2024-11-30",
          azure_result: { pages: [{ pageNumber: 1 }] },
        },
      ],
    });
    expect(progress).toEqual([50, 100]);
    expect(deps.azure.analyze).toHaveBeenCalledTimes(2);
    expect(deps.preparer.cleanup).toHaveBeenCalledOnce();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "request-file-1",
        batch_id: "batch-1",
        client_file_id: "drive-file-1",
        file_name: "file-1.pdf",
        status: "success",
        retry_count: 4,
        error_code: null,
      }),
      "File processing completed",
    );
  });

  it("resumes unfinished parts without splitting or resubmitting completed parts", async () => {
    const repository = await repositoryWith([
      file("file-1", "/tmp/source-1", {
        status: "processing",
        page_count: 3,
        parts: [
          {
            part_number: 1,
            start_page: 1,
            end_page: 2,
            temporary_path: "/tmp/part-1",
            size_bytes: 10,
            retry_count: 0,
            azure_status: "succeeded",
            azure_result: {
              pages: [
                { pageNumber: 1, lines: [{ content: "Page one" }] },
                { pageNumber: 2, lines: [{ content: "Page two" }] },
              ],
              tables: [],
            },
          },
          {
            part_number: 2,
            start_page: 3,
            end_page: 3,
            temporary_path: "/tmp/part-2",
            size_bytes: 10,
            retry_count: 1,
            azure_status: "processing",
            operation_location:
              "https://sample.test/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-2?api-version=2024-11-30",
          },
        ],
      }),
    ]);
    const deps = dependencies(repository);
    const processor = new FileProcessor(deps);

    await processor.process({ batchId: "batch-1", fileJobId: "file-1" });

    expect(deps.preparer.prepare).not.toHaveBeenCalled();
    expect(deps.azure.analyze).toHaveBeenCalledOnce();
    expect(deps.azure.analyze.mock.calls[0]?.[2]).toMatchObject({
      operationLocation:
        "https://sample.test/documentintelligence/documentModels/prebuilt-layout/analyzeResults/result-2?api-version=2024-11-30",
    });
    expect((await repository.get("batch-1"))?.files[0]?.status).toBe("success");
  });

  it("processes files concurrently and isolates a permanent failure", async () => {
    const repository = await repositoryWith([
      file("good", "/tmp/good"),
      file("bad", "/tmp/bad"),
    ]);
    const deps = dependencies(repository);
    deps.preparer.prepare.mockImplementation((sourcePath: string) =>
      Promise.resolve({
        sourcePath,
        pageCount: 1,
        parts: [
          {
            partNumber: 1,
            startPage: 1,
            endPage: 1,
            temporaryPath: sourcePath,
            sizeBytes: 10,
          },
        ],
      }),
    );
    let active = 0;
    let maximumActive = 0;
    deps.azure.analyze.mockImplementation(async (document: Uint8Array) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (Buffer.from(document).toString().includes("bad")) {
        throw new AzureAdapterError(
          "AZURE_INVALID_DOCUMENT",
          "Dokumen ditolak oleh Azure.",
          false,
        );
      }
      return {
        pages: [
          {
            pageNumber: 1,
            lines: [{ content: "ok" }],
            words: [],
          },
        ],
        tables: [],
      };
    });
    const processor = new FileProcessor(deps);

    await Promise.all([
      processor.process({ batchId: "batch-1", fileJobId: "good" }),
      processor.process({ batchId: "batch-1", fileJobId: "bad" }),
    ]);

    const updated = await repository.get("batch-1");
    expect(maximumActive).toBe(2);
    expect(
      updated?.files.find((item) => item.file_job_id === "good")?.status,
    ).toBe("success");
    expect(
      updated?.files.find((item) => item.file_job_id === "bad"),
    ).toMatchObject({
      status: "failed",
      result_ready: false,
      error: {
        code: "AZURE_INVALID_DOCUMENT",
        message: "Dokumen ditolak oleh Azure.",
      },
    });
    expect(deps.preparer.cleanup).toHaveBeenCalledTimes(2);
  });

  it("finishes a file that was interrupted while merging", async () => {
    const repository = await repositoryWith([
      file("file-1", "/tmp/source-1", {
        status: "merging",
        page_count: 1,
        parts: [
          {
            part_number: 1,
            start_page: 1,
            end_page: 1,
            temporary_path: "/tmp/part-1",
            size_bytes: 10,
            retry_count: 0,
            azure_status: "succeeded",
            azure_result: {
              pages: [{ pageNumber: 1, lines: [{ content: "Recovered" }] }],
              tables: [],
            },
          },
        ],
      }),
    ]);
    const deps = dependencies(repository);

    await new FileProcessor(deps).process({
      batchId: "batch-1",
      fileJobId: "file-1",
    });

    expect(deps.azure.analyze).not.toHaveBeenCalled();
    expect((await repository.get("batch-1"))?.files[0]).toMatchObject({
      status: "success",
      result_ready: true,
      result: { data: { text: "Recovered" } },
    });
    expect(deps.preparer.cleanup).toHaveBeenCalledOnce();
  });

  it("fails safely when the stored Azure result is malformed", async () => {
    const repository = await repositoryWith([
      file("file-1", "/tmp/source-1", {
        status: "merging",
        page_count: 1,
        parts: [
          {
            part_number: 1,
            start_page: 1,
            end_page: 1,
            temporary_path: "/tmp/part-1",
            size_bytes: 10,
            retry_count: 0,
            azure_status: "succeeded",
            azure_result: { pages: [] },
          },
        ],
      }),
    ]);
    const deps = dependencies(repository);

    await new FileProcessor(deps).process({
      batchId: "batch-1",
      fileJobId: "file-1",
    });

    expect((await repository.get("batch-1"))?.files[0]).toMatchObject({
      status: "failed",
      result_ready: false,
      error: {
        code: "AZURE_INVALID_RESPONSE",
        message: "Hasil Azure tidak valid.",
      },
    });
    expect(deps.preparer.cleanup).toHaveBeenCalledOnce();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "request-file-1",
        batch_id: "batch-1",
        client_file_id: "drive-file-1",
        file_name: "file-1.pdf",
        status: "failed",
        error_code: "AZURE_INVALID_RESPONSE",
      }),
      "File processing failed",
    );
  });

  it("marks an exhausted queue job as failed and cleans its temporary data", async () => {
    const repository = await repositoryWith([
      file("file-1", "/tmp/source-1", {
        status: "processing",
        page_count: 1,
        parts: [
          {
            part_number: 1,
            start_page: 1,
            end_page: 1,
            temporary_path: "/tmp/part-1",
            size_bytes: 10,
            retry_count: 0,
            azure_status: "processing",
          },
        ],
      }),
    ]);
    const deps = dependencies(repository);
    const processor = new FileProcessor(deps);

    await processor.failPermanently(
      { batchId: "batch-1", fileJobId: "file-1" },
      "PROCESSING_INTERRUPTED",
      "Pemrosesan terhenti setelah beberapa percobaan.",
    );

    expect((await repository.get("batch-1"))?.files[0]).toMatchObject({
      status: "failed",
      error: {
        code: "PROCESSING_INTERRUPTED",
        message: "Pemrosesan terhenti setelah beberapa percobaan.",
      },
    });
    expect(deps.preparer.cleanup).toHaveBeenCalledOnce();
  });

  it("processes more than 15 files successfully with a mock Azure adapter", async () => {
    const files = Array.from({ length: 16 }, (_, index) =>
      file(`file-${String(index + 1)}`, `/tmp/source-${String(index + 1)}`),
    );
    const repository = await repositoryWith(files);
    const deps = dependencies(repository);
    deps.preparer.prepare.mockImplementation((sourcePath: string) =>
      Promise.resolve({
        sourcePath,
        pageCount: 1,
        parts: [
          {
            partNumber: 1,
            startPage: 1,
            endPage: 1,
            temporaryPath: sourcePath,
            sizeBytes: 10,
          },
        ],
      }),
    );
    deps.azure.analyze.mockResolvedValue({
      pages: [
        {
          pageNumber: 1,
          lines: [{ content: "recognized" }],
          words: [],
        },
      ],
      tables: [],
    });
    const processor = new FileProcessor(deps);

    await Promise.all(
      files.map(async (item) =>
        processor.process({
          batchId: "batch-1",
          fileJobId: item.file_job_id,
        }),
      ),
    );

    const completed = await repository.get("batch-1");
    expect(completed?.status).toBe("completed");
    expect(completed?.files).toHaveLength(16);
    expect(completed?.files.every((item) => item.status === "success")).toBe(
      true,
    );
    expect(deps.azure.analyze).toHaveBeenCalledTimes(16);
  });

  it("makes a fast file available while a slower file is still processing", async () => {
    const repository = await repositoryWith([
      file("fast", "/tmp/fast"),
      file("slow", "/tmp/slow"),
    ]);
    const deps = dependencies(repository);
    deps.preparer.prepare.mockImplementation((sourcePath: string) =>
      Promise.resolve({
        sourcePath,
        pageCount: 1,
        parts: [
          {
            partNumber: 1,
            startPage: 1,
            endPage: 1,
            temporaryPath: sourcePath,
            sizeBytes: 10,
          },
        ],
      }),
    );
    let releaseSlow: (() => void) | undefined;
    deps.azure.analyze.mockImplementation(async (document: Uint8Array) => {
      if (Buffer.from(document).toString().includes("slow")) {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return {
        pages: [
          {
            pageNumber: 1,
            lines: [{ content: "recognized" }],
            words: [],
          },
        ],
        tables: [],
      };
    });
    const processor = new FileProcessor(deps);
    const slow = processor.process({
      batchId: "batch-1",
      fileJobId: "slow",
    });

    await processor.process({ batchId: "batch-1", fileJobId: "fast" });

    const duringProcessing = await repository.get("batch-1");
    expect(duringProcessing?.status).toBe("processing");
    expect(
      duringProcessing?.files.find((item) => item.file_job_id === "fast"),
    ).toMatchObject({ status: "success", result_ready: true });
    expect(
      duringProcessing?.files.find((item) => item.file_job_id === "slow")
        ?.status,
    ).toBe("processing");

    releaseSlow?.();
    await slow;
    expect((await repository.get("batch-1"))?.status).toBe("completed");
  });
});

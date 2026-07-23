import {
  AzureAdapterError,
  type DocumentAnalysisAdapter,
} from "../infrastructure/azure/azure-document-intelligence-adapter.js";
import type { SupportedMimeType } from "../infrastructure/storage/temporary-file-storage.js";
import type {
  PreparedDocument,
  PreparedPart,
} from "../modules/documents/document-preparer.js";
import { InvalidPdfError } from "../modules/documents/pdf-splitter.js";
import type {
  BatchRecord,
  FileJobRecord,
  JobRepository,
  PartJobRecord,
} from "../modules/jobs/job-repository.js";
import type { FileJobData } from "../infrastructure/queue/file-job-queue.js";
import {
  InvalidOcrResultError,
  normalizeOcrResult,
} from "../modules/ocr/ocr-result-normalizer.js";

interface FileProcessorStorage {
  read(path: string): Promise<Buffer>;
}

interface FileProcessorPreparer {
  prepare(
    sourcePath: string,
    mimeType: SupportedMimeType,
  ): Promise<PreparedDocument>;
  cleanup(document: PreparedDocument): Promise<void>;
}

export interface FileProcessorLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface FileProcessorDependencies {
  repository: JobRepository;
  storage: FileProcessorStorage;
  preparer: FileProcessorPreparer;
  azure: DocumentAnalysisAdapter;
  logger: FileProcessorLogger;
}

type ProgressReporter = (percentage: number) => Promise<void>;

function toPartRecord(part: PreparedPart): PartJobRecord {
  return {
    part_number: part.partNumber,
    start_page: part.startPage,
    end_page: part.endPage,
    temporary_path: part.temporaryPath,
    size_bytes: part.sizeBytes,
    retry_count: 0,
    azure_status: "queued",
  };
}

function toPreparedDocument(file: FileJobRecord): PreparedDocument | null {
  if (file.page_count === undefined || file.parts === undefined) return null;
  return {
    sourcePath: file.source_path,
    pageCount: file.page_count,
    parts: file.parts.map((part) => ({
      partNumber: part.part_number,
      startPage: part.start_page,
      endPage: part.end_page,
      temporaryPath: part.temporary_path,
      sizeBytes: part.size_bytes,
    })),
  };
}

function findFile(batch: BatchRecord, fileJobId: string): FileJobRecord | null {
  return batch.files.find((file) => file.file_job_id === fileJobId) ?? null;
}

export class FileProcessor {
  constructor(private readonly dependencies: FileProcessorDependencies) {}

  async process(
    data: FileJobData,
    reportProgress: ProgressReporter = () => Promise.resolve(),
  ): Promise<void> {
    const startedAt = Date.now();
    const batch = await this.dependencies.repository.get(data.batchId);
    const file = batch === null ? null : findFile(batch, data.fileJobId);
    if (batch === null || file === null) {
      throw new Error("File job record was not found");
    }
    if (["success", "failed"].includes(file.status)) return;

    let prepared = toPreparedDocument(file);

    try {
      if (prepared === null) {
        await this.update(data, { status: "validating" });
        await this.update(data, { status: "splitting" });
        prepared = await this.dependencies.preparer.prepare(
          file.source_path,
          file.mime_type,
        );
        file.page_count = prepared.pageCount;
        file.parts = prepared.parts.map(toPartRecord);
        await this.update(data, {
          status: "processing",
          page_count: file.page_count,
          parts: file.parts,
        });
      } else {
        await this.update(data, { status: "processing" });
      }

      const parts = file.parts;
      if (parts === undefined || parts.length === 0) {
        throw new InvalidPdfError("Dokumen tidak memiliki bagian yang valid.");
      }

      let completed = parts.filter(
        (part) => part.azure_status === "succeeded",
      ).length;

      for (const part of parts) {
        if (part.azure_status === "succeeded") continue;

        part.azure_status = "processing";
        await this.update(data, { parts });
        const document = await this.dependencies.storage.read(
          part.temporary_path,
        );
        const result = await this.dependencies.azure.analyze(
          document,
          file.mime_type,
          {
            locale: file.language,
            ...(part.operation_location === undefined
              ? {}
              : { operationLocation: part.operation_location }),
            onSubmitted: async (operationLocation) => {
              part.operation_location = operationLocation;
              await this.update(data, { parts });
            },
            onRetry: async (retryCount) => {
              part.retry_count = retryCount;
              await this.update(data, { parts });
            },
          },
        );
        part.azure_status = "succeeded";
        part.azure_result = result;
        await this.update(data, { parts });
        completed += 1;
        await reportProgress(Math.round((completed / parts.length) * 100));
      }

      await this.update(data, { status: "merging", parts });
      const result = normalizeOcrResult(file);
      await this.update(data, {
        status: "success",
        result_ready: true,
        parts,
        result,
      });
      await this.dependencies.preparer.cleanup(prepared);
      this.dependencies.logger.info(
        {
          request_id: file.request_id ?? null,
          batch_id: data.batchId,
          client_file_id: file.client_file_id,
          file_name: file.file_name,
          status: "success",
          duration_ms: Date.now() - startedAt,
          retry_count: parts.reduce(
            (total, part) => total + part.retry_count,
            0,
          ),
          error_code: null,
        },
        "File processing completed",
      );
    } catch (error) {
      if (!(
        error instanceof InvalidPdfError ||
        error instanceof AzureAdapterError ||
        error instanceof InvalidOcrResultError
      )) {
        throw error;
      }

      if (prepared !== null) {
        await this.dependencies.preparer.cleanup(prepared);
      }
      await this.update(data, {
        status: "failed",
        result_ready: false,
        error: { code: error.code, message: error.message },
      });
      this.dependencies.logger.error(
        {
          request_id: file.request_id ?? null,
          batch_id: data.batchId,
          client_file_id: file.client_file_id,
          file_name: file.file_name,
          status: "failed",
          duration_ms: Date.now() - startedAt,
          retry_count:
            file.parts?.reduce((total, part) => total + part.retry_count, 0) ??
            0,
          error_code: error.code,
        },
        "File processing failed",
      );
    }
  }

  async failPermanently(
    data: FileJobData,
    code: string,
    message: string,
  ): Promise<void> {
    const batch = await this.dependencies.repository.get(data.batchId);
    const file = batch === null ? null : findFile(batch, data.fileJobId);
    if (file === null || ["success", "failed"].includes(file.status)) {
      return;
    }

    const prepared = toPreparedDocument(file);
    try {
      if (prepared !== null) await this.dependencies.preparer.cleanup(prepared);
    } finally {
      await this.update(data, {
        status: "failed",
        result_ready: false,
        error: { code, message },
      });
    }
  }

  private async update(
    data: FileJobData,
    update: Parameters<JobRepository["updateFile"]>[2],
  ): Promise<void> {
    const result = await this.dependencies.repository.updateFile(
      data.batchId,
      data.fileJobId,
      update,
    );
    if (result === null) throw new Error("File job record was not found");
  }
}

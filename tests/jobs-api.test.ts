import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app/build-app.js";
import { TemporaryFileStorage } from "../src/infrastructure/storage/temporary-file-storage.js";
import {
  noOpFileJobQueue,
  type FileJobQueue,
} from "../src/infrastructure/queue/file-job-queue.js";
import { JobService } from "../src/modules/jobs/job-service.js";
import { createMultipartRequest } from "./helpers/multipart.js";
import { MemoryJobRepository } from "./helpers/memory-job-repository.js";

const API_KEY = "phase-3-test-api-key";
const DEFAULT_LIMITS = {
  maxFileSizeBytes: 1024,
  maxBatchSizeBytes: 32 * 1024,
  maxFilesPerBatch: 15,
};

interface TestContext {
  app: FastifyInstance;
  repository: MemoryJobRepository;
  storage: TemporaryFileStorage;
}

const temporaryDirectories: string[] = [];

function validPdf(content: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${content}`);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function createTestContext(
  limits: typeof DEFAULT_LIMITS = DEFAULT_LIMITS,
  queue: FileJobQueue = noOpFileJobQueue,
  rateLimits = { uploadRequestsPerMinute: 30, statusRequestsPerMinute: 300 },
): TestContext {
  const repository = new MemoryJobRepository();
  const service = new JobService(
    repository,
    {
      jobTtlSeconds: 24 * 60 * 60,
      idempotencyTtlSeconds: 24 * 60 * 60,
    },
    queue,
  );
  const temporaryDirectory = join(
    tmpdir(),
    `azure-ocr-api-test-${randomUUID()}`,
  );
  temporaryDirectories.push(temporaryDirectory);
  const storage = new TemporaryFileStorage(temporaryDirectory);
  const app = buildApp({
    logger: false,
    jobs: {
      service,
      serviceApiKey: API_KEY,
      storage,
      ...rateLimits,
      ...limits,
    },
  });

  return { app, repository, storage };
}

function metadataFor(names: string[]) {
  return names.map((fileName, index) => ({
    client_file_id: `drive-${String(index + 1)}`,
    file_name: fileName,
    language: "id-ID",
    modified_time: "2026-07-22T10:00:00.000Z",
  }));
}

describe("job API", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.map(async (app) => app.close()));
    apps.length = 0;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(async (directory) =>
          TemporaryFileStorage.removeDirectory(directory),
        ),
    );
  });

  it("rejects a request without the API key before accepting files", async () => {
    const { app } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("document") }],
      metadataFor(["manual.pdf"]),
      "batch-key-1",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: request.headers,
      payload: request.payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "API key tidak valid." },
    });
  });

  it("rejects a non-multipart request", async () => {
    const { app } = createTestContext();
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { "x-api-key": API_KEY },
      payload: { files: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("creates a queued batch and exposes per-file status", async () => {
    const { app } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("document") }],
      metadataFor(["../manual.pdf"]),
      "batch-key-2",
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ status: "queued", file_count: 1 });

    const batchId = created.json<{ batch_id: string }>().batch_id;
    const status = await app.inject({
      method: "GET",
      url: `/v1/ocr/jobs/${batchId}`,
      headers: { "x-api-key": API_KEY },
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      batch_id: batchId,
      status: "queued",
      progress: {
        total: 1,
        success: 0,
        failed: 0,
        processing: 0,
        queued: 1,
      },
      files: [
        {
          client_file_id: "drive-1",
          file_name: "manual.pdf",
          status: "queued",
          result_ready: false,
        },
      ],
    });
  });

  it("accepts repeated files fields in request order", async () => {
    const { app, repository } = createTestContext();
    apps.push(app);
    const first = validPdf("first");
    const second = validPdf("second");
    const request = createMultipartRequest(
      [
        { name: "first.pdf", content: first },
        { name: "second.pdf", content: second },
      ],
      metadataFor(["first.pdf", "second.pdf"]),
      "repeated-files-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });
    const batch = await repository.get(
      response.json<{ batch_id: string }>().batch_id,
    );

    expect(response.statusCode).toBe(202);
    expect(batch?.files.map((file) => file.sha256)).toEqual([
      sha256(first),
      sha256(second),
    ]);
  });

  it("accepts file_1 through file_15 in numeric order", async () => {
    const { app, repository } = createTestContext();
    apps.push(app);
    const numberedFiles = Array.from({ length: 15 }, (_, index) => {
      const number = index + 1;
      return {
        number,
        name: `page-${String(number)}.pdf`,
        content: validPdf(`page-${String(number)}`),
      };
    });
    const request = createMultipartRequest(
      numberedFiles.toReversed().map(({ number, name, content }) => ({
        name,
        content,
        fieldName: `file_${String(number)}`,
      })),
      metadataFor(numberedFiles.map(({ name }) => name)),
      "numbered-files-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });
    const batch = await repository.get(
      response.json<{ batch_id: string }>().batch_id,
    );

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ file_count: 15 });
    expect(batch?.files.map((file) => file.sha256)).toEqual(
      numberedFiles.map(({ content }) => sha256(content)),
    );
  });

  it("orders file_2 before file_10 by number", async () => {
    const { app, repository } = createTestContext();
    apps.push(app);
    const second = validPdf("second");
    const tenth = validPdf("tenth");
    const request = createMultipartRequest(
      [
        { name: "ten.pdf", content: tenth, fieldName: "file_10" },
        { name: "two.pdf", content: second, fieldName: "file_2" },
      ],
      metadataFor(["two.pdf", "ten.pdf"]),
      "numeric-order-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });
    const batch = await repository.get(
      response.json<{ batch_id: string }>().batch_id,
    );

    expect(response.statusCode).toBe(202);
    expect(batch?.files.map((file) => file.sha256)).toEqual([
      sha256(second),
      sha256(tenth),
    ]);
  });

  it("returns the existing batch for an identical retry", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("same document") }],
      metadataFor(["manual.pdf"]),
      "retry-key",
    );
    const options = {
      method: "POST" as const,
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    };

    const first = await app.inject(options);
    const second = await app.inject(options);

    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    await expect(storage.list()).resolves.toHaveLength(1);
  });

  it("retains the original upload and recovers when queue publishing is retried", async () => {
    const enqueue = vi
      .fn<FileJobQueue["enqueue"]>()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValue(undefined);
    const { app, storage } = createTestContext(DEFAULT_LIMITS, { enqueue });
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("queue recovery") }],
      metadataFor(["manual.pdf"]),
      "queue-recovery-key",
    );
    const options = {
      method: "POST" as const,
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    };

    const unavailable = await app.inject(options);
    const recovered = await app.inject(options);

    expect(unavailable.statusCode).toBe(503);
    expect(recovered.statusCode).toBe(202);
    await expect(storage.list()).resolves.toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("returns 409 when the same key is reused for different content", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const metadata = metadataFor(["manual.pdf"]);
    const first = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("first") }],
      metadata,
      "conflict-key",
    );
    const second = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("second") }],
      metadata,
      "conflict-key",
    );

    await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...first.headers, "x-api-key": API_KEY },
      payload: first.payload,
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...second.headers, "x-api-key": API_KEY },
      payload: second.payload,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "Idempotency key sudah dipakai untuk request berbeda.",
      },
    });
    await expect(storage.list()).resolves.toHaveLength(1);
  });

  it("detects the type from content and retains a successful upload", async () => {
    const { app, repository, storage } = createTestContext();
    apps.push(app);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const request = createMultipartRequest(
      [{ name: "fake.pdf", content: png, contentType: "application/pdf" }],
      metadataFor(["fake.pdf"]),
      "content-type-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });
    const batch = await repository.get(
      response.json<{ batch_id: string }>().batch_id,
    );

    expect(response.statusCode).toBe(202);
    expect(batch?.files[0]?.mime_type).toBe("image/png");
    await expect(storage.list()).resolves.toHaveLength(1);
  });

  it("rejects unsupported content and leaves no temporary data", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "fake.pdf", content: "plain text" }],
      metadataFor(["fake.pdf"]),
      "spoof-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("rejects more than 15 files and removes temporary data", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const names = Array.from(
      { length: 16 },
      (_, index) => `page-${String(index)}.pdf`,
    );
    const request = createMultipartRequest(
      names.map((name) => ({ name, content: validPdf("x") })),
      metadataFor(names),
      "large-batch-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("rejects a batch without files", async () => {
    const { app } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest([], [], "empty-batch-key");

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects metadata that does not match the file count", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [
        {
          name: "manual.pdf",
          content: validPdf("document"),
          fieldName: "file_1",
        },
      ],
      [],
      "metadata-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("rejects an unknown multipart file field", async () => {
    const { app, storage } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [
        {
          name: "manual.pdf",
          content: validPdf("document"),
          fieldName: "document",
        },
      ],
      metadataFor(["manual.pdf"]),
      "unknown-field-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    await expect(storage.list()).resolves.toEqual([]);
  });

  it("rejects malformed metadata JSON", async () => {
    const { app } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("document") }],
      "{",
      "malformed-metadata-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects a file over the configured size", async () => {
    const { app } = createTestContext({
      maxFileSizeBytes: 3,
      maxBatchSizeBytes: 100,
      maxFilesPerBatch: 15,
    });
    apps.push(app);
    const request = createMultipartRequest(
      [{ name: "manual.pdf", content: validPdf("1234") }],
      metadataFor(["manual.pdf"]),
      "file-size-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("rejects files over the configured total batch size", async () => {
    const { app } = createTestContext({
      maxFileSizeBytes: 10,
      maxBatchSizeBytes: 5,
      maxFilesPerBatch: 15,
    });
    apps.push(app);
    const request = createMultipartRequest(
      [
        { name: "one.pdf", content: validPdf("123") },
        { name: "two.pdf", content: validPdf("456") },
      ],
      metadataFor(["one.pdf", "two.pdf"]),
      "batch-size-key",
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("returns one completed file while another file is still queued", async () => {
    const { app, repository } = createTestContext();
    apps.push(app);
    const request = createMultipartRequest(
      [
        { name: "one.pdf", content: validPdf("first") },
        { name: "two.pdf", content: validPdf("second") },
      ],
      metadataFor(["one.pdf", "two.pdf"]),
      "partial-result-key",
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...request.headers, "x-api-key": API_KEY },
      payload: request.payload,
    });
    const batchId = created.json<{ batch_id: string }>().batch_id;
    const batch = await repository.get(batchId);
    const first = batch?.files[0];
    if (first === undefined) throw new Error("Expected the first file job");
    const result = {
      client_file_id: first.client_file_id,
      status: "success" as const,
      document: {
        file_name: first.file_name,
        language: first.language,
        page_count: 1,
      },
      data: { text: "First result", tables: [] },
      confidence: 0.9,
    };
    await repository.updateFile(batchId, first.file_job_id, {
      status: "success",
      result_ready: true,
      result,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/ocr/jobs/${batchId}`,
      headers: { "x-api-key": API_KEY },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processing",
      progress: { total: 2, success: 1, queued: 1 },
      files: [
        { status: "success", result_ready: true, result },
        { status: "queued", result_ready: false },
      ],
    });
  });

  it("rejects an invalid batch ID", async () => {
    const { app } = createTestContext();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/ocr/jobs/not-a-uuid",
      headers: { "x-api-key": API_KEY },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("returns 404 for an unknown batch", async () => {
    const { app } = createTestContext();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/ocr/jobs/00000000-0000-4000-8000-000000000000",
      headers: { "x-api-key": API_KEY },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "JOB_NOT_FOUND", message: "Batch tidak ditemukan." },
    });
  });

  it("limits upload and status requests independently", async () => {
    const { app } = createTestContext(DEFAULT_LIMITS, noOpFileJobQueue, {
      uploadRequestsPerMinute: 1,
      statusRequestsPerMinute: 1,
    });
    apps.push(app);
    const firstRequest = createMultipartRequest(
      [{ name: "one.pdf", content: validPdf("one") }],
      metadataFor(["one.pdf"]),
      "rate-limit-one",
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...firstRequest.headers, "x-api-key": API_KEY },
      payload: firstRequest.payload,
    });
    const secondRequest = createMultipartRequest(
      [{ name: "two.pdf", content: validPdf("two") }],
      metadataFor(["two.pdf"]),
      "rate-limit-two",
    );

    const rejectedUpload = await app.inject({
      method: "POST",
      url: "/v1/ocr/jobs",
      headers: { ...secondRequest.headers, "x-api-key": API_KEY },
      payload: secondRequest.payload,
    });
    const batchId = created.json<{ batch_id: string }>().batch_id;
    const firstStatus = await app.inject({
      method: "GET",
      url: `/v1/ocr/jobs/${batchId}`,
      headers: { "x-api-key": API_KEY },
    });
    const rejectedStatus = await app.inject({
      method: "GET",
      url: `/v1/ocr/jobs/${batchId}`,
      headers: { "x-api-key": API_KEY },
    });
    const health = await app.inject({ method: "GET", url: "/health" });

    expect(created.statusCode).toBe(202);
    expect(rejectedUpload.statusCode).toBe(429);
    expect(rejectedUpload.headers["retry-after"]).toBe("60");
    expect(firstStatus.statusCode).toBe(200);
    expect(rejectedStatus.statusCode).toBe(429);
    expect(health.statusCode).toBe(200);
  });
});

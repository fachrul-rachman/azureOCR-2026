import { createHash, randomUUID } from "node:crypto";

import {
  noOpFileJobQueue,
  type FileJobQueue,
} from "../../infrastructure/queue/file-job-queue.js";
import {
  createQueuedBatch,
  parseMetadata,
  toBatchStatus,
  type BatchStatusResponse,
} from "./job-domain.js";
import {
  IdempotencyConflictError,
  JobNotFoundError,
  ValidationError,
  QueueUnavailableError,
} from "./job-errors.js";
import type { BatchRecord, JobRepository } from "./job-repository.js";

export interface UploadedFile {
  uploadName: string;
  declaredMimeType: string;
  mimeType: "application/pdf" | "image/png" | "image/jpeg" | "image/tiff";
  temporaryPath: string;
  size: number;
  sha256: string;
}

export interface CreateBatchCommand {
  files: UploadedFile[];
  metadata: unknown;
  idempotencyKey: string;
  requestId?: string;
}

export interface JobServiceOptions {
  jobTtlSeconds: number;
  idempotencyTtlSeconds: number;
}

function validateIdempotencyKey(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0 || normalized.length > 256) {
    throw new ValidationError([
      {
        field: "idempotency_key",
        message: "Wajib diisi dan maksimal 256 karakter.",
      },
    ]);
  }

  return normalized;
}

export class JobService {
  constructor(
    private readonly repository: JobRepository,
    private readonly options: JobServiceOptions,
    private readonly queue: FileJobQueue = noOpFileJobQueue,
  ) {}

  async createBatch(
    command: CreateBatchCommand,
  ): Promise<{ batch: BatchRecord; created: boolean }> {
    if (command.files.length === 0) {
      throw new ValidationError([
        { field: "files", message: "Minimal satu file wajib dikirim." },
      ]);
    }

    const idempotencyKey = validateIdempotencyKey(command.idempotencyKey);
    const metadata = parseMetadata(command.metadata, command.files.length);
    const fileFingerprints = command.files.map((file) => ({
      size: file.size,
      sha256: file.sha256,
    }));
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ files: fileFingerprints, metadata }))
      .digest("hex");
    const batch = createQueuedBatch(
      randomUUID(),
      new Date().toISOString(),
      metadata,
      command.files,
      command.requestId,
    );
    const result = await this.repository.store({
      batch,
      idempotencyKey,
      requestFingerprint,
      jobTtlSeconds: this.options.jobTtlSeconds,
      idempotencyTtlSeconds: this.options.idempotencyTtlSeconds,
    });

    if (result.outcome === "conflict") {
      throw new IdempotencyConflictError();
    }

    try {
      await this.queue.enqueue(result.batch);
    } catch {
      throw new QueueUnavailableError(result.outcome === "created");
    }

    return { batch: result.batch, created: result.outcome === "created" };
  }

  async getBatchStatus(batchId: string): Promise<BatchStatusResponse> {
    const batch = await this.repository.get(batchId);

    if (batch === null) {
      throw new JobNotFoundError();
    }

    return toBatchStatus(batch);
  }
}

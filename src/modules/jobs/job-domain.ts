import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import type { UploadedFile } from "./job-service.js";

import type {
  BatchRecord,
  FileJobRecord,
  FileJobStatus,
  OcrFileResult,
} from "./job-repository.js";
import { ValidationError } from "./job-errors.js";

export interface JobMetadata {
  client_file_id: string;
  file_name: string;
  language: string;
  modified_time: string | null;
}

export interface BatchStatusResponse {
  batch_id: string;
  status: BatchRecord["status"];
  progress: {
    total: number;
    success: number;
    failed: number;
    processing: number;
    queued: number;
  };
  files: Array<{
    client_file_id: string;
    file_name: string;
    status: FileJobStatus;
    result_ready: boolean;
    result?: OcrFileResult;
    error?: { code: string; message: string };
  }>;
}

export function calculateBatchStatus(
  files: FileJobRecord[],
): BatchRecord["status"] {
  const success = files.filter((file) => file.status === "success").length;
  const failed = files.filter((file) => file.status === "failed").length;

  if (success === files.length) return "completed";
  if (failed === files.length) return "failed";
  if (success + failed === files.length) return "partial";
  if (files.every((file) => file.status === "queued")) return "queued";
  return "processing";
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError([{ field, message: "Wajib diisi." }]);
  }

  const normalized = value.trim();

  if (normalized.length > maxLength) {
    throw new ValidationError([
      { field, message: `Maksimal ${String(maxLength)} karakter.` },
    ]);
  }

  return normalized;
}

export function sanitizeFileName(value: unknown, field: string): string {
  const fileName = requiredString(value, field, 1024).replaceAll("\\", "/");
  const safeName = basename(fileName)
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();

  if (safeName.length === 0 || safeName === "." || safeName === "..") {
    throw new ValidationError([{ field, message: "Nama file tidak valid." }]);
  }

  return safeName.slice(0, 255);
}

function parseModifiedTime(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError([
      { field, message: "Waktu perubahan tidak valid." },
    ]);
  }

  return new Date(value).toISOString();
}

export function parseMetadata(
  value: unknown,
  fileCount: number,
): JobMetadata[] {
  if (!Array.isArray(value) || value.length !== fileCount) {
    throw new ValidationError([
      {
        field: "metadata",
        message: "Jumlah metadata harus sama dengan jumlah file.",
      },
    ]);
  }

  return value.map((item, index) => {
    const itemField = `metadata[${String(index)}]`;

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ValidationError([
        { field: itemField, message: "Metadata tidak valid." },
      ]);
    }

    const metadata = item as Record<string, unknown>;
    const language =
      metadata.language === undefined
        ? "id-ID"
        : requiredString(metadata.language, `${itemField}.language`, 35);

    return {
      client_file_id: requiredString(
        metadata.client_file_id,
        `${itemField}.client_file_id`,
        256,
      ),
      file_name: sanitizeFileName(metadata.file_name, `${itemField}.file_name`),
      language,
      modified_time: parseModifiedTime(
        metadata.modified_time,
        `${itemField}.modified_time`,
      ),
    };
  });
}

export function createQueuedBatch(
  batchId: string,
  createdAt: string,
  metadata: JobMetadata[],
  uploads: UploadedFile[],
  requestId?: string,
): BatchRecord {
  const files: FileJobRecord[] = metadata.map((file, index) => {
    const upload = uploads[index];

    if (upload === undefined) {
      throw new Error("Upload data does not match metadata");
    }

    return {
      ...file,
      file_job_id: randomUUID(),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      status: "queued",
      result_ready: false,
      source_path: upload.temporaryPath,
      mime_type: upload.mimeType,
      size_bytes: upload.size,
      sha256: upload.sha256,
    };
  });

  return {
    batch_id: batchId,
    status: "queued",
    created_at: createdAt,
    files,
  };
}

export function toBatchStatus(batch: BatchRecord): BatchStatusResponse {
  const progress = {
    total: batch.files.length,
    success: 0,
    failed: 0,
    processing: 0,
    queued: 0,
  };

  for (const file of batch.files) {
    if (file.status === "success") {
      progress.success += 1;
    } else if (file.status === "failed") {
      progress.failed += 1;
    } else if (file.status === "queued") {
      progress.queued += 1;
    } else {
      progress.processing += 1;
    }
  }

  return {
    batch_id: batch.batch_id,
    status: batch.status,
    progress,
    files: batch.files.map((file) => ({
      client_file_id: file.client_file_id,
      file_name: file.file_name,
      status: file.status,
      result_ready: file.result_ready,
      ...(file.status === "success" && file.result !== undefined
        ? { result: file.result }
        : {}),
      ...(file.error === undefined ? {} : { error: file.error }),
    })),
  };
}

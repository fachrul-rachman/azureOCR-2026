import type { FastifyRequest } from "fastify";

import {
  TemporaryFileStorage,
  UnsupportedDocumentTypeError,
} from "../../infrastructure/storage/temporary-file-storage.js";
import { ValidationError } from "./job-errors.js";
import type { CreateBatchCommand, UploadedFile } from "./job-service.js";

export interface UploadLimits {
  maxFileSizeBytes: number;
  maxBatchSizeBytes: number;
  maxFilesPerBatch: number;
}

interface PendingFile {
  file: UploadedFile;
  number?: bigint;
}

const NUMBERED_FILE_FIELD = /^file_(\d+)$/;

function readTextField(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ValidationError([
      { field: fieldName, message: "Nilai harus berupa teks." },
    ]);
  }

  return value;
}

export async function parseJobUpload(
  request: FastifyRequest,
  limits: UploadLimits,
  storage: TemporaryFileStorage,
): Promise<CreateBatchCommand> {
  const contentLength = request.headers["content-length"];

  if (
    contentLength !== undefined &&
    Number(contentLength) > limits.maxBatchSizeBytes
  ) {
    throw new ValidationError([
      { field: "files", message: "Ukuran total request terlalu besar." },
    ]);
  }

  const repeatedFiles: PendingFile[] = [];
  const numberedFiles: PendingFile[] = [];
  let metadataText: string | undefined;
  let idempotencyKey: string | undefined;
  let totalFileSize = 0;
  let fileCount = 0;

  const parts = request.parts({
    limits: {
      fileSize: limits.maxFileSizeBytes,
      fields: 2,
      fieldSize: 1024 * 1024,
      parts: Number.POSITIVE_INFINITY,
    },
  });

  try {
    for await (const part of parts) {
      if (part.type === "file") {
        const numberedMatch = NUMBERED_FILE_FIELD.exec(part.fieldname);
        if (part.fieldname !== "files" && numberedMatch === null) {
          part.file.resume();
          throw new ValidationError([
            { field: part.fieldname, message: "Field file tidak dikenal." },
          ]);
        }

        fileCount += 1;
        if (fileCount > limits.maxFilesPerBatch) {
          part.file.resume();
          throw new ValidationError([
            {
              field: "files",
              message: `Maksimal ${String(limits.maxFilesPerBatch)} file per batch.`,
            },
          ]);
        }

        let stored;

        try {
          stored = await storage.store(
            part.file as AsyncIterable<Buffer>,
            (chunkSize) => {
              totalFileSize += chunkSize;
              if (totalFileSize > limits.maxBatchSizeBytes) {
                throw new ValidationError([
                  {
                    field: "files",
                    message: "Ukuran total request terlalu besar.",
                  },
                ]);
              }
            },
          );
        } catch (error) {
          if (error instanceof UnsupportedDocumentTypeError) {
            throw new ValidationError([
              { field: "files", message: "Jenis file tidak didukung." },
            ]);
          }
          throw error;
        }

        const file: UploadedFile = {
          uploadName: part.filename,
          declaredMimeType: part.mimetype,
          mimeType: stored.mimeType,
          temporaryPath: stored.path,
          size: stored.size,
          sha256: stored.sha256,
        };
        if (numberedMatch === null) {
          repeatedFiles.push({ file });
        } else {
          numberedFiles.push({ file, number: BigInt(numberedMatch[1] ?? "0") });
        }
        continue;
      }

      if (part.fieldname === "metadata") {
        if (metadataText !== undefined) {
          throw new ValidationError([
            { field: "metadata", message: "Field tidak boleh diulang." },
          ]);
        }
        metadataText = readTextField(part.value, "metadata");
      } else if (part.fieldname === "idempotency_key") {
        if (idempotencyKey !== undefined) {
          throw new ValidationError([
            {
              field: "idempotency_key",
              message: "Field tidak boleh diulang.",
            },
          ]);
        }
        idempotencyKey = readTextField(part.value, "idempotency_key");
      } else {
        throw new ValidationError([
          { field: part.fieldname, message: "Field tidak dikenal." },
        ]);
      }
    }
  } catch (error) {
    await storage.removeMany(
      [...repeatedFiles, ...numberedFiles].map(
        ({ file }) => file.temporaryPath,
      ),
    );
    throw error;
  }

  if (metadataText === undefined) {
    throw new ValidationError([{ field: "metadata", message: "Wajib diisi." }]);
  }

  if (idempotencyKey === undefined) {
    throw new ValidationError([
      { field: "idempotency_key", message: "Wajib diisi." },
    ]);
  }

  let metadata: unknown;

  try {
    metadata = JSON.parse(metadataText) as unknown;
  } catch {
    throw new ValidationError([
      { field: "metadata", message: "JSON tidak valid." },
    ]);
  }

  numberedFiles.sort((left, right) => {
    if (left.number === right.number) return 0;
    return (left.number ?? 0n) < (right.number ?? 0n) ? -1 : 1;
  });

  return {
    files: [...repeatedFiles, ...numberedFiles].map(({ file }) => file),
    metadata,
    idempotencyKey,
  };
}

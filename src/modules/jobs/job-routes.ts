import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

import { FixedWindowRateLimiter } from "../../infrastructure/rate-limit/fixed-window-rate-limiter.js";
import type { TemporaryFileStorage } from "../../infrastructure/storage/temporary-file-storage.js";
import { isValidApiKey } from "./api-key.js";
import {
  JobError,
  QueueUnavailableError,
  ValidationError,
} from "./job-errors.js";
import type { JobService } from "./job-service.js";
import { parseJobUpload, type UploadLimits } from "./upload-parser.js";

export interface JobRouteOptions extends UploadLimits {
  service: JobService;
  serviceApiKey: string;
  storage: TemporaryFileStorage;
  uploadRequestsPerMinute: number;
  statusRequestsPerMinute: number;
  rateLimitNow?: () => number;
}

function errorBody(error: JobError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export const jobRoutes: FastifyPluginAsync<JobRouteOptions> = async (
  app,
  options,
) => {
  const uploadLimiter = new FixedWindowRateLimiter(
    options.uploadRequestsPerMinute,
    60_000,
    options.rateLimitNow,
  );
  const statusLimiter = new FixedWindowRateLimiter(
    options.statusRequestsPerMinute,
    60_000,
    options.rateLimitNow,
  );
  const rateLimitKey = createHash("sha256")
    .update(options.serviceApiKey, "utf8")
    .digest("hex");

  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: options.maxFileSizeBytes,
      fields: 2,
      fieldSize: 1024 * 1024,
      parts: Number.POSITIVE_INFINITY,
    },
  });

  app.addHook("onRequest", (request, reply, done) => {
    if (!isValidApiKey(request.headers["x-api-key"], options.serviceApiKey)) {
      void reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "API key tidak valid." },
      });
      return;
    }

    const result =
      request.method === "POST"
        ? uploadLimiter.consume(rateLimitKey)
        : statusLimiter.consume(rateLimitKey);
    if (!result.allowed) {
      void reply
        .header("retry-after", String(result.retryAfterSeconds))
        .code(429)
        .send({
          error: {
            code: "RATE_LIMITED",
            message: "Terlalu banyak request. Coba lagi sebentar.",
          },
        });
      return;
    }

    done();
  });

  app.post("/v1/ocr/jobs", async (request, reply) => {
    const startedAt = Date.now();
    let uploadedPaths: string[] = [];
    let retained = false;

    try {
      const command = await parseJobUpload(request, options, options.storage);
      uploadedPaths = command.files.map((file) => file.temporaryPath);
      const result = await options.service.createBatch({
        ...command,
        requestId: request.id,
      });

      if (result.created) retained = true;
      else await options.storage.removeMany(uploadedPaths);

      for (const file of result.batch.files) {
        request.log.info(
          {
            request_id: request.id,
            batch_id: result.batch.batch_id,
            client_file_id: file.client_file_id,
            file_name: file.file_name,
            status: file.status,
            duration_ms: Date.now() - startedAt,
            retry_count: 0,
            error_code: null,
          },
          "OCR file accepted",
        );
      }

      reply.code(202).send({
        batch_id: result.batch.batch_id,
        status: result.batch.status,
        file_count: result.batch.files.length,
      });
      return;
    } catch (error) {
      if (error instanceof QueueUnavailableError && error.retainUploads) {
        retained = true;
      }
      if (!retained) await options.storage.removeMany(uploadedPaths);
      if (error instanceof JobError) {
        return reply.code(error.statusCode).send(errorBody(error));
      }

      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        const validationError = new ValidationError([
          { field: "files", message: "Ukuran file terlalu besar." },
        ]);
        return reply
          .code(validationError.statusCode)
          .send(errorBody(validationError));
      }

      if (
        Object.values(app.multipartErrors).some(
          (ErrorType) => error instanceof ErrorType,
        )
      ) {
        const validationError = new ValidationError([
          { field: "request", message: "Format multipart tidak valid." },
        ]);
        return reply
          .code(validationError.statusCode)
          .send(errorBody(validationError));
      }

      request.log.error({ err: error }, "Failed to create OCR batch");
      return reply.code(500).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Terjadi kesalahan internal.",
        },
      });
    }
  });

  app.get<{ Params: { jobId: string } }>(
    "/v1/ocr/jobs/:jobId",
    async (request, reply) => {
      try {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            request.params.jobId,
          )
        ) {
          throw new ValidationError([
            { field: "jobId", message: "ID batch tidak valid." },
          ]);
        }

        return await options.service.getBatchStatus(request.params.jobId);
      } catch (error) {
        if (error instanceof JobError) {
          return reply.code(error.statusCode).send(errorBody(error));
        }

        request.log.error({ err: error }, "Failed to read OCR batch");
        return reply.code(500).send({
          error: {
            code: "INTERNAL_ERROR",
            message: "Terjadi kesalahan internal.",
          },
        });
      }
    },
  );
};

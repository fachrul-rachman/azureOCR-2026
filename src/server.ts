import { Queue } from "bullmq";

import { buildApp } from "./app/build-app.js";
import { loadApiSettings } from "./config/api-settings.js";
import { loadEnvironment } from "./config/environment.js";
import { loadWorkerSettings } from "./config/worker-settings.js";
import { createLoggerOptions } from "./infrastructure/logger/logger-options.js";
import {
  createRedisConnection,
  ensureRedisReady,
} from "./infrastructure/queue/redis-connection.js";
import { RedisJobRepository } from "./infrastructure/queue/redis-job-repository.js";
import { BullMqFileJobQueue } from "./infrastructure/queue/bullmq-file-job-queue.js";
import {
  FILE_JOB_QUEUE_NAME,
  type FileJobData,
} from "./infrastructure/queue/file-job-queue.js";
import { TemporaryFileStorage } from "./infrastructure/storage/temporary-file-storage.js";
import { JobService } from "./modules/jobs/job-service.js";
import { createGracefulShutdown } from "./shared/graceful-shutdown.js";

const environment = loadEnvironment(process.env);
const apiSettings = loadApiSettings(process.env);
const workerSettings = loadWorkerSettings(process.env);
const redis = createRedisConnection(environment);
const jobRepository = new RedisJobRepository(redis);
const bullQueue = new Queue<FileJobData>(FILE_JOB_QUEUE_NAME, {
  connection: redis,
});
const fileJobQueue = new BullMqFileJobQueue(bullQueue, {
  attempts: workerSettings.queueAttempts,
  backoffMs: workerSettings.queueBackoffMs,
  retentionSeconds: workerSettings.jobTtlSeconds,
});
const jobService = new JobService(jobRepository, apiSettings, fileJobQueue);
const storage = new TemporaryFileStorage(environment.tempDir);
await storage.initialize();
const app = buildApp({
  logger: createLoggerOptions(environment.logLevel),
  readinessCheck: async () => ensureRedisReady(redis),
  jobs: {
    service: jobService,
    serviceApiKey: apiSettings.serviceApiKey,
    maxFileSizeBytes: apiSettings.maxFileSizeBytes,
    maxBatchSizeBytes: apiSettings.maxBatchSizeBytes,
    maxFilesPerBatch: apiSettings.maxFilesPerBatch,
    uploadRequestsPerMinute: apiSettings.uploadRequestsPerMinute,
    statusRequestsPerMinute: apiSettings.statusRequestsPerMinute,
    storage,
  },
});

redis.on("error", (error) => {
  app.log.error({ err: error }, "API Redis connection error");
});

try {
  await ensureRedisReady(redis);
  await app.listen({
    host: environment.host,
    port: environment.port,
  });
  const shutdown = createGracefulShutdown(async () => {
    await app.close();
    await bullQueue.close();
    await redis.quit();
  }, app.log);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(() => {
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  app.log.fatal({ err: error }, "API failed to start");
  await bullQueue.close().catch(() => undefined);
  redis.disconnect();
  process.exitCode = 1;
}

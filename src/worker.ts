import pino from "pino";

import { loadAzureSettings } from "./config/azure-settings.js";
import { loadEnvironment } from "./config/environment.js";
import { loadWorkerSettings } from "./config/worker-settings.js";
import { AzureDocumentIntelligenceAdapter } from "./infrastructure/azure/azure-document-intelligence-adapter.js";
import {
  IoredisRateLimitStore,
  RedisAzureRateLimiter,
} from "./infrastructure/azure/redis-azure-rate-limiter.js";
import { createLoggerOptions } from "./infrastructure/logger/logger-options.js";
import { createBullMqFileWorker } from "./infrastructure/queue/bullmq-file-worker.js";
import {
  createRedisConnection,
  createWorkerRedisConnection,
} from "./infrastructure/queue/redis-connection.js";
import { RedisJobRepository } from "./infrastructure/queue/redis-job-repository.js";
import { TemporaryFileStorage } from "./infrastructure/storage/temporary-file-storage.js";
import { DocumentPreparer } from "./modules/documents/document-preparer.js";
import { FileProcessor } from "./workers/file-processor.js";
import { prepareWorker } from "./workers/worker-service.js";
import { TemporaryFileCleanupScheduler } from "./workers/temporary-file-cleanup-scheduler.js";
import { createGracefulShutdown } from "./shared/graceful-shutdown.js";

const environment = loadEnvironment(process.env);
const azureSettings = loadAzureSettings(process.env);
const workerSettings = loadWorkerSettings(process.env);
const logger = pino(createLoggerOptions(environment.logLevel));
const redis = createRedisConnection(environment);
const workerRedis = createWorkerRedisConnection(environment);

redis.on("error", (error) => {
  logger.error({ err: error }, "Worker Redis connection error");
});
workerRedis.on("error", () => {
  logger.error(
    { error_code: "QUEUE_REDIS_CONNECTION_ERROR" },
    "Queue Redis connection error",
  );
});

try {
  await prepareWorker(redis, logger);
  const storage = new TemporaryFileStorage(environment.tempDir);
  await storage.initialize();
  const cleanupScheduler = new TemporaryFileCleanupScheduler(
    storage,
    workerSettings.cleanupIntervalMs,
    workerSettings.jobTtlSeconds * 1_000,
    logger,
  );
  await cleanupScheduler.start();
  const repository = new RedisJobRepository(redis);
  const limiter = new RedisAzureRateLimiter(
    new IoredisRateLimitStore(redis),
    azureSettings.submitRequestsPerSecond,
    azureSettings.pollRequestsPerSecond,
  );
  const azure = new AzureDocumentIntelligenceAdapter(azureSettings, limiter);
  const preparer = new DocumentPreparer(
    storage,
    workerSettings.maxAzureInputSizeBytes,
  );
  const processor = new FileProcessor({
    repository,
    storage,
    preparer,
    azure,
    logger,
  });
  const queueWorker = createBullMqFileWorker(
    workerRedis,
    workerSettings.concurrency,
    processor,
    logger,
  );
  const shutdown = createGracefulShutdown(async () => {
    await cleanupScheduler.close();
    await queueWorker.close();
    await Promise.all([redis.quit(), workerRedis.quit()]);
  }, logger);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(() => {
        process.exitCode = 1;
      });
    });
  }
} catch (error) {
  logger.fatal({ err: error }, "Worker failed to start");
  redis.disconnect();
  workerRedis.disconnect();
  process.exitCode = 1;
}

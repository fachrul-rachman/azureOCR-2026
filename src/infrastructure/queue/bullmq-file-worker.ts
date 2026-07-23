import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import type { FileProcessor } from "../../workers/file-processor.js";
import { FILE_JOB_QUEUE_NAME, type FileJobData } from "./file-job-queue.js";

interface QueueWorkerLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createBullMqFileWorker(
  connection: Redis,
  concurrency: number,
  processor: FileProcessor,
  logger: QueueWorkerLogger,
): Worker<FileJobData> {
  const worker = new Worker<FileJobData>(
    FILE_JOB_QUEUE_NAME,
    async (job) => {
      await processor.process(job.data, async (percentage) => {
        await job.updateProgress(percentage);
      });
    },
    {
      connection,
      concurrency,
      maxStalledCount: 1,
    },
  );

  worker.on("error", () => {
    logger.error(
      { error_code: "QUEUE_WORKER_ERROR" },
      "Queue worker encountered an error",
    );
  });

  worker.on("stalled", (jobId) => {
    logger.info(
      { file_job_id: jobId, status: "stalled" },
      "File job will be recovered",
    );
  });

  worker.on("failed", (job: Job<FileJobData> | undefined) => {
    if (job === undefined) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return;

    void processor
      .failPermanently(
        job.data,
        "PROCESSING_INTERRUPTED",
        "Pemrosesan terhenti setelah beberapa percobaan.",
      )
      .catch(() => {
        logger.error(
          {
            batch_id: job.data.batchId,
            file_job_id: job.data.fileJobId,
            error_code: "FINAL_STATUS_UPDATE_FAILED",
          },
          "Failed to store final file status",
        );
      });
  });

  return worker;
}

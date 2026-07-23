import type { JobsOptions, Queue } from "bullmq";

import type { BatchRecord } from "../../modules/jobs/job-repository.js";
import type { FileJobData, FileJobQueue } from "./file-job-queue.js";

interface BulkQueue {
  addBulk(
    jobs: Array<{
      name: string;
      data: FileJobData;
      opts: JobsOptions;
    }>,
  ): Promise<unknown>;
}

export interface BullMqFileJobQueueOptions {
  attempts: number;
  backoffMs: number;
  retentionSeconds: number;
}

export class BullMqFileJobQueue implements FileJobQueue {
  constructor(
    private readonly queue: BulkQueue | Queue<FileJobData>,
    private readonly options: BullMqFileJobQueueOptions,
  ) {}

  async enqueue(batch: BatchRecord): Promise<void> {
    await this.queue.addBulk(
      batch.files.map((file) => ({
        name: "process-file",
        data: { batchId: batch.batch_id, fileJobId: file.file_job_id },
        opts: {
          jobId: file.file_job_id,
          attempts: this.options.attempts,
          backoff: { type: "exponential", delay: this.options.backoffMs },
          removeOnComplete: { age: this.options.retentionSeconds },
          removeOnFail: { age: this.options.retentionSeconds },
        },
      })),
    );
  }
}

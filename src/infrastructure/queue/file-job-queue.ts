import type { BatchRecord } from "../../modules/jobs/job-repository.js";

export interface FileJobData {
  batchId: string;
  fileJobId: string;
}

export const FILE_JOB_QUEUE_NAME = "ocr-file-jobs";

export interface FileJobQueue {
  enqueue(batch: BatchRecord): Promise<void>;
}

export const noOpFileJobQueue: FileJobQueue = {
  enqueue: () => Promise.resolve(),
};

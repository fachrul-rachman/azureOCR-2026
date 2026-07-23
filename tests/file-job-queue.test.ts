import { describe, expect, it, vi } from "vitest";

import { BullMqFileJobQueue } from "../src/infrastructure/queue/bullmq-file-job-queue.js";
import type { BatchRecord } from "../src/modules/jobs/job-repository.js";

const batch: BatchRecord = {
  batch_id: "batch-1",
  status: "queued",
  created_at: "2026-07-23T00:00:00.000Z",
  files: [
    {
      file_job_id: "file-job-1",
      client_file_id: "drive-1",
      file_name: "one.pdf",
      language: "id-ID",
      modified_time: null,
      status: "queued",
      result_ready: false,
      source_path: "/tmp/source",
      mime_type: "application/pdf",
      size_bytes: 10,
      sha256: "a".repeat(64),
    },
  ],
};

describe("file job queue", () => {
  it("uses stable job IDs and retains queue records for the job TTL", async () => {
    const addBulk = vi.fn().mockResolvedValue([]);
    const queue = new BullMqFileJobQueue(
      { addBulk },
      { attempts: 3, backoffMs: 1_000, retentionSeconds: 86_400 },
    );

    await queue.enqueue(batch);

    expect(addBulk).toHaveBeenCalledWith([
      {
        name: "process-file",
        data: { batchId: "batch-1", fileJobId: "file-job-1" },
        opts: {
          jobId: "file-job-1",
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 86_400 },
        },
      },
    ]);
  });
});

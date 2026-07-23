import { describe, expect, it, vi } from "vitest";

import type { FileJobQueue } from "../src/infrastructure/queue/file-job-queue.js";
import { QueueUnavailableError } from "../src/modules/jobs/job-errors.js";
import {
  JobService,
  type CreateBatchCommand,
} from "../src/modules/jobs/job-service.js";
import { MemoryJobRepository } from "./helpers/memory-job-repository.js";

const command: CreateBatchCommand = {
  files: [
    {
      uploadName: "one.pdf",
      declaredMimeType: "application/pdf",
      mimeType: "application/pdf",
      temporaryPath: "/tmp/one",
      size: 10,
      sha256: "a".repeat(64),
    },
  ],
  metadata: [
    {
      client_file_id: "drive-1",
      file_name: "one.pdf",
      language: "id-ID",
    },
  ],
  idempotencyKey: "queue-key",
};

describe("job service queue publishing", () => {
  it("safely re-enqueues an identical request using the existing batch", async () => {
    const repository = new MemoryJobRepository();
    const enqueue = vi.fn<FileJobQueue["enqueue"]>(() => Promise.resolve());
    const queue: FileJobQueue = {
      enqueue,
    };
    const service = new JobService(
      repository,
      { jobTtlSeconds: 86_400, idempotencyTtlSeconds: 86_400 },
      queue,
    );

    const first = await service.createBatch(command);
    const second = await service.createBatch(command);

    expect(second.batch.batch_id).toBe(first.batch.batch_id);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1]?.[0].batch_id).toBe(first.batch.batch_id);
  });

  it("marks whether stored uploads must be retained when enqueue fails", async () => {
    const repository = new MemoryJobRepository();
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error("redis detail")),
    };
    const service = new JobService(
      repository,
      { jobTtlSeconds: 86_400, idempotencyTtlSeconds: 86_400 },
      queue,
    );

    const firstError = await service
      .createBatch(command)
      .catch((error: unknown) => error);
    const retryError = await service
      .createBatch(command)
      .catch((error: unknown) => error);

    expect(firstError).toBeInstanceOf(QueueUnavailableError);
    expect(firstError).toMatchObject({ retainUploads: true });
    expect(String(firstError)).not.toContain("redis detail");
    expect(retryError).toMatchObject({ retainUploads: false });
  });
});

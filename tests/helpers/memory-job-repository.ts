import type {
  BatchRecord,
  JobRepository,
  StoreBatchRequest,
  StoreBatchResult,
  FileJobUpdate,
} from "../../src/modules/jobs/job-repository.js";
import { calculateBatchStatus } from "../../src/modules/jobs/job-domain.js";

export class MemoryJobRepository implements JobRepository {
  private readonly batches = new Map<string, BatchRecord>();
  private readonly idempotency = new Map<
    string,
    { batchId: string; fingerprint: string }
  >();

  store(request: StoreBatchRequest): Promise<StoreBatchResult> {
    const existing = this.idempotency.get(request.idempotencyKey);

    if (existing !== undefined) {
      if (existing.fingerprint !== request.requestFingerprint) {
        return Promise.resolve({ outcome: "conflict" });
      }

      const batch = this.batches.get(existing.batchId);

      if (batch !== undefined) {
        return Promise.resolve({ outcome: "existing", batch });
      }
    }

    this.batches.set(request.batch.batch_id, request.batch);
    this.idempotency.set(request.idempotencyKey, {
      batchId: request.batch.batch_id,
      fingerprint: request.requestFingerprint,
    });

    return Promise.resolve({ outcome: "created", batch: request.batch });
  }

  get(batchId: string): Promise<BatchRecord | null> {
    return Promise.resolve(this.batches.get(batchId) ?? null);
  }

  updateFile(
    batchId: string,
    fileJobId: string,
    update: FileJobUpdate,
  ): Promise<BatchRecord | null> {
    const batch = this.batches.get(batchId);
    if (batch === undefined) return Promise.resolve(null);
    const index = batch.files.findIndex(
      (file) => file.file_job_id === fileJobId,
    );
    const current = batch.files[index];
    if (index < 0 || current === undefined) return Promise.resolve(null);

    batch.files[index] = { ...current, ...update };
    batch.status = calculateBatchStatus(batch.files);
    return Promise.resolve(batch);
  }
}

export class JobError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export class ValidationError extends JobError {
  constructor(details: Array<{ field: string; message: string }>) {
    super(400, "VALIDATION_ERROR", "Request tidak valid.", details);
    this.name = "ValidationError";
  }
}

export class IdempotencyConflictError extends JobError {
  constructor() {
    super(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key sudah dipakai untuk request berbeda.",
    );
    this.name = "IdempotencyConflictError";
  }
}

export class JobNotFoundError extends JobError {
  constructor() {
    super(404, "JOB_NOT_FOUND", "Batch tidak ditemukan.");
    this.name = "JobNotFoundError";
  }
}

export class QueueUnavailableError extends JobError {
  constructor(readonly retainUploads: boolean) {
    super(
      503,
      "QUEUE_UNAVAILABLE",
      "Antrean pemrosesan sedang tidak tersedia.",
    );
    this.name = "QueueUnavailableError";
  }
}

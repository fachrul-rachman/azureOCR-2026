export interface WorkerSettings {
  concurrency: number;
  maxAzureInputSizeBytes: number;
  queueAttempts: number;
  queueBackoffMs: number;
  jobTtlSeconds: number;
  cleanupIntervalMs: number;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadWorkerSettings(
  environment: NodeJS.ProcessEnv,
): WorkerSettings {
  return {
    concurrency: positiveInteger(
      environment.FILE_WORKER_CONCURRENCY,
      "FILE_WORKER_CONCURRENCY",
      3,
    ),
    maxAzureInputSizeBytes:
      positiveInteger(
        environment.AZURE_MAX_INPUT_SIZE_MB,
        "AZURE_MAX_INPUT_SIZE_MB",
        4,
      ) *
      1024 *
      1024,
    queueAttempts: positiveInteger(
      environment.FILE_JOB_MAX_ATTEMPTS,
      "FILE_JOB_MAX_ATTEMPTS",
      3,
    ),
    queueBackoffMs: positiveInteger(
      environment.FILE_JOB_BACKOFF_MS,
      "FILE_JOB_BACKOFF_MS",
      1_000,
    ),
    jobTtlSeconds:
      positiveInteger(environment.JOB_TTL_HOURS, "JOB_TTL_HOURS", 24) * 60 * 60,
    cleanupIntervalMs:
      positiveInteger(
        environment.CLEANUP_INTERVAL_MINUTES,
        "CLEANUP_INTERVAL_MINUTES",
        60,
      ) *
      60 *
      1_000,
  };
}

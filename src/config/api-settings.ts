export interface ApiSettings {
  serviceApiKey: string;
  maxFileSizeBytes: number;
  maxBatchSizeBytes: number;
  jobTtlSeconds: number;
  idempotencyTtlSeconds: number;
  maxAzureInputSizeBytes: number;
  uploadRequestsPerMinute: number;
  statusRequestsPerMinute: number;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function loadApiSettings(environment: NodeJS.ProcessEnv): ApiSettings {
  const serviceApiKey = environment.SERVICE_API_KEY;

  if (serviceApiKey === undefined || serviceApiKey.trim().length === 0) {
    throw new Error("SERVICE_API_KEY is required");
  }

  const maxFileSizeMb = positiveInteger(
    environment.MAX_FILE_SIZE_MB,
    "MAX_FILE_SIZE_MB",
    50,
  );
  const maxBatchSizeMb = positiveInteger(
    environment.MAX_BATCH_SIZE_MB,
    "MAX_BATCH_SIZE_MB",
    250,
  );
  const jobTtlHours = positiveInteger(
    environment.JOB_TTL_HOURS,
    "JOB_TTL_HOURS",
    24,
  );
  const idempotencyTtlHours = positiveInteger(
    environment.IDEMPOTENCY_TTL_HOURS,
    "IDEMPOTENCY_TTL_HOURS",
    24,
  );
  const maxAzureInputSizeMb = positiveInteger(
    environment.AZURE_MAX_INPUT_SIZE_MB,
    "AZURE_MAX_INPUT_SIZE_MB",
    4,
  );

  return {
    serviceApiKey,
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    maxBatchSizeBytes: maxBatchSizeMb * 1024 * 1024,
    jobTtlSeconds: jobTtlHours * 60 * 60,
    idempotencyTtlSeconds: idempotencyTtlHours * 60 * 60,
    maxAzureInputSizeBytes: maxAzureInputSizeMb * 1024 * 1024,
    uploadRequestsPerMinute: positiveInteger(
      environment.API_UPLOAD_REQUESTS_PER_MINUTE,
      "API_UPLOAD_REQUESTS_PER_MINUTE",
      30,
    ),
    statusRequestsPerMinute: positiveInteger(
      environment.API_STATUS_REQUESTS_PER_MINUTE,
      "API_STATUS_REQUESTS_PER_MINUTE",
      300,
    ),
  };
}

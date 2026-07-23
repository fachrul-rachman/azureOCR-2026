const SUPPORTED_API_VERSION = "2024-11-30";

export interface AzureSettings {
  tier: "F0" | "S0";
  endpoint: string;
  key: string;
  apiVersion: typeof SUPPORTED_API_VERSION;
  modelId: string;
  requestTimeoutMs: number;
  operationTimeoutMs: number;
  pollIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  submitRequestsPerSecond: number;
  pollRequestsPerSecond: number;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
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

function nonNegativeInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseEndpoint(value: string | undefined): string {
  const raw = required(value, "AZURE_ENDPOINT");
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("AZURE_ENDPOINT must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("AZURE_ENDPOINT must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("AZURE_ENDPOINT must not contain credentials");
  }

  return url.origin;
}

export function loadAzureSettings(
  environment: NodeJS.ProcessEnv,
): AzureSettings {
  const tier = environment.AZURE_TIER ?? "F0";
  if (tier !== "F0" && tier !== "S0") {
    throw new Error("AZURE_TIER is not supported");
  }
  const apiVersion = environment.AZURE_API_VERSION ?? SUPPORTED_API_VERSION;
  if (apiVersion !== SUPPORTED_API_VERSION) {
    throw new Error("AZURE_API_VERSION is not supported");
  }

  const modelId = environment.AZURE_MODEL_ID ?? "prebuilt-layout";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$/.test(modelId)) {
    throw new Error("AZURE_MODEL_ID is invalid");
  }

  return {
    tier,
    endpoint: parseEndpoint(environment.AZURE_ENDPOINT),
    key: required(environment.AZURE_KEY, "AZURE_KEY"),
    apiVersion,
    modelId,
    requestTimeoutMs: positiveInteger(
      environment.AZURE_REQUEST_TIMEOUT_MS,
      "AZURE_REQUEST_TIMEOUT_MS",
      30_000,
    ),
    operationTimeoutMs: positiveInteger(
      environment.AZURE_OPERATION_TIMEOUT_MS,
      "AZURE_OPERATION_TIMEOUT_MS",
      120_000,
    ),
    pollIntervalMs: positiveInteger(
      environment.AZURE_POLL_INTERVAL_MS,
      "AZURE_POLL_INTERVAL_MS",
      2_000,
    ),
    maxRetries: nonNegativeInteger(
      environment.AZURE_MAX_RETRIES,
      "AZURE_MAX_RETRIES",
      3,
    ),
    retryBaseDelayMs: positiveInteger(
      environment.AZURE_RETRY_BASE_DELAY_MS,
      "AZURE_RETRY_BASE_DELAY_MS",
      1_000,
    ),
    submitRequestsPerSecond: positiveInteger(
      environment.AZURE_SUBMIT_REQUESTS_PER_SECOND,
      "AZURE_SUBMIT_REQUESTS_PER_SECOND",
      tier === "F0" ? 1 : 15,
    ),
    pollRequestsPerSecond: positiveInteger(
      environment.AZURE_POLL_REQUESTS_PER_SECOND,
      "AZURE_POLL_REQUESTS_PER_SECOND",
      tier === "F0" ? 1 : 50,
    ),
  };
}

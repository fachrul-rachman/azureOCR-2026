import { describe, expect, it } from "vitest";

import { loadApiSettings } from "../src/config/api-settings.js";

describe("API settings", () => {
  it("requires the service API key", () => {
    expect(() => loadApiSettings({})).toThrow("SERVICE_API_KEY is required");
  });

  it("loads secure upload and TTL defaults", () => {
    expect(loadApiSettings({ SERVICE_API_KEY: "secret" })).toEqual({
      serviceApiKey: "secret",
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxBatchSizeBytes: 250 * 1024 * 1024,
      jobTtlSeconds: 24 * 60 * 60,
      idempotencyTtlSeconds: 24 * 60 * 60,
      maxAzureInputSizeBytes: 4 * 1024 * 1024,
      uploadRequestsPerMinute: 30,
      statusRequestsPerMinute: 300,
    });
  });

  it.each([
    ["MAX_FILE_SIZE_MB", "0"],
    ["MAX_BATCH_SIZE_MB", "invalid"],
    ["JOB_TTL_HOURS", "-1"],
    ["IDEMPOTENCY_TTL_HOURS", "1.5"],
    ["AZURE_MAX_INPUT_SIZE_MB", "0"],
    ["API_UPLOAD_REQUESTS_PER_MINUTE", "0"],
    ["API_STATUS_REQUESTS_PER_MINUTE", "1.5"],
  ])("rejects invalid %s", (name, value) => {
    expect(() =>
      loadApiSettings({ SERVICE_API_KEY: "secret", [name]: value }),
    ).toThrow(`${name} must be a positive integer`);
  });
});

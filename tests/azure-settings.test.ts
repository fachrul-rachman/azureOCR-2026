import { describe, expect, it } from "vitest";

import { loadAzureSettings } from "../src/config/azure-settings.js";

describe("Azure settings", () => {
  it("loads safe F0 defaults", () => {
    expect(
      loadAzureSettings({
        AZURE_ENDPOINT: "https://sample.cognitiveservices.azure.com/",
        AZURE_KEY: "secret",
      }),
    ).toEqual({
      tier: "F0",
      endpoint: "https://sample.cognitiveservices.azure.com",
      key: "secret",
      apiVersion: "2024-11-30",
      modelId: "prebuilt-layout",
      requestTimeoutMs: 30_000,
      operationTimeoutMs: 120_000,
      pollIntervalMs: 2_000,
      maxRetries: 3,
      retryBaseDelayMs: 1_000,
      submitRequestsPerSecond: 1,
      pollRequestsPerSecond: 1,
    });
  });

  it("uses official default request limits for S0", () => {
    expect(
      loadAzureSettings({
        AZURE_TIER: "S0",
        AZURE_ENDPOINT: "https://sample.cognitiveservices.azure.com",
        AZURE_KEY: "secret",
      }),
    ).toMatchObject({
      tier: "S0",
      submitRequestsPerSecond: 15,
      pollRequestsPerSecond: 50,
    });
  });

  it.each([
    [{ AZURE_KEY: "secret" }, "AZURE_ENDPOINT is required"],
    [
      { AZURE_ENDPOINT: "https://sample.test", AZURE_KEY: "" },
      "AZURE_KEY is required",
    ],
    [
      { AZURE_ENDPOINT: "http://sample.test", AZURE_KEY: "secret" },
      "AZURE_ENDPOINT must use HTTPS",
    ],
    [
      {
        AZURE_ENDPOINT: "https://sample.test",
        AZURE_KEY: "secret",
        AZURE_API_VERSION: "preview",
      },
      "AZURE_API_VERSION is not supported",
    ],
    [
      {
        AZURE_ENDPOINT: "https://sample.test",
        AZURE_KEY: "secret",
        AZURE_MAX_RETRIES: "-1",
      },
      "AZURE_MAX_RETRIES must be a non-negative integer",
    ],
    [
      {
        AZURE_TIER: "paid",
        AZURE_ENDPOINT: "https://sample.test",
        AZURE_KEY: "secret",
      },
      "AZURE_TIER is not supported",
    ],
  ])("rejects unsafe settings", (environment, message) => {
    expect(() => loadAzureSettings(environment)).toThrow(message);
  });
});

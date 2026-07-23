import { describe, expect, it } from "vitest";

import { loadWorkerSettings } from "../src/config/worker-settings.js";

describe("worker settings", () => {
  it("loads conservative defaults", () => {
    expect(loadWorkerSettings({})).toEqual({
      concurrency: 3,
      maxAzureInputSizeBytes: 4 * 1024 * 1024,
      queueAttempts: 3,
      queueBackoffMs: 1_000,
      jobTtlSeconds: 24 * 60 * 60,
      cleanupIntervalMs: 60 * 60 * 1_000,
    });
  });

  it.each([
    ["FILE_WORKER_CONCURRENCY", "0"],
    ["AZURE_MAX_INPUT_SIZE_MB", "invalid"],
    ["FILE_JOB_MAX_ATTEMPTS", "-1"],
    ["FILE_JOB_BACKOFF_MS", "1.5"],
    ["JOB_TTL_HOURS", "0"],
    ["CLEANUP_INTERVAL_MINUTES", "invalid"],
  ])("rejects invalid %s", (name, value) => {
    expect(() => loadWorkerSettings({ [name]: value })).toThrow(
      `${name} must be a positive integer`,
    );
  });
});

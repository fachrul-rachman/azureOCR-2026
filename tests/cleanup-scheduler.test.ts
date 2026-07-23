import { describe, expect, it, vi } from "vitest";

import { TemporaryFileCleanupScheduler } from "../src/workers/temporary-file-cleanup-scheduler.js";

describe("temporary file cleanup scheduler", () => {
  it("cleans expired files at startup and on schedule without overlap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T10:00:00.000Z"));
    let release: (() => void) | undefined;
    const removeOlderThan = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = () => {
              resolve(1);
            };
          }),
      );
    const logger = { info: vi.fn(), error: vi.fn() };
    const scheduler = new TemporaryFileCleanupScheduler(
      { removeOlderThan },
      60_000,
      24 * 60 * 60 * 1_000,
      logger,
    );

    await scheduler.start();
    expect(removeOlderThan).toHaveBeenCalledWith(
      new Date("2026-07-22T10:00:00.000Z").getTime(),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removeOlderThan).toHaveBeenCalledTimes(2);
    release?.();
    await scheduler.close();
    expect(logger.info).toHaveBeenCalledWith(
      { status: "cleaned", deleted_count: 2 },
      "Expired temporary files removed",
    );
    vi.useRealTimers();
  });

  it("logs a safe error and continues after cleanup fails", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const scheduler = new TemporaryFileCleanupScheduler(
      { removeOlderThan: vi.fn().mockRejectedValue(new Error("private path")) },
      60_000,
      1_000,
      logger,
    );

    await scheduler.start();
    await scheduler.close();

    expect(logger.error).toHaveBeenCalledWith(
      { error_code: "TEMP_CLEANUP_FAILED" },
      "Temporary file cleanup failed",
    );
  });
});

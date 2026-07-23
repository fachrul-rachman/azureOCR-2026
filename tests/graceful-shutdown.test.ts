import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "../src/shared/graceful-shutdown.js";

describe("graceful shutdown", () => {
  it("waits for resources once when multiple signals arrive", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), error: vi.fn() };
    const shutdown = createGracefulShutdown(close, logger);

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(close).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { signal: "SIGTERM", status: "shutting_down" },
      "Graceful shutdown started",
    );
    expect(logger.info).toHaveBeenCalledWith(
      { signal: "SIGTERM", status: "stopped" },
      "Graceful shutdown completed",
    );
  });

  it("records shutdown failure without exposing the internal error", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const shutdown = createGracefulShutdown(
      vi.fn().mockRejectedValue(new Error("secret detail")),
      logger,
    );

    await expect(shutdown("SIGTERM")).rejects.toThrow("secret detail");
    expect(logger.error).toHaveBeenCalledWith(
      {
        signal: "SIGTERM",
        status: "shutdown_failed",
        error_code: "GRACEFUL_SHUTDOWN_FAILED",
      },
      "Graceful shutdown failed",
    );
  });
});

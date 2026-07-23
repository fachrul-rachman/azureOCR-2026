import { describe, expect, it, vi } from "vitest";

import { prepareWorker } from "../src/workers/worker-service.js";

describe("worker startup", () => {
  it("verifies Redis before declaring itself ready", async () => {
    const redis = {
      status: "wait",
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
    };
    const logger = {
      info: vi.fn(),
    };

    await prepareWorker(redis, logger);

    expect(redis.connect).toHaveBeenCalledOnce();
    expect(redis.ping).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { status: "ready" },
      "Worker connected to Redis",
    );
  });
});

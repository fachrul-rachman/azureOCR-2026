import { describe, expect, it, vi } from "vitest";

import { ensureRedisReady } from "../src/infrastructure/queue/redis-connection.js";

describe("Redis connection", () => {
  it("connects a new client and verifies it with ping", async () => {
    const client = {
      status: "wait",
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
    };

    await ensureRedisReady(client);

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.ping).toHaveBeenCalledOnce();
  });

  it("does not reconnect an active client", async () => {
    const client = {
      status: "ready",
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
    };

    await ensureRedisReady(client);

    expect(client.connect).not.toHaveBeenCalled();
  });

  it("rejects an unexpected ping response", async () => {
    const client = {
      status: "ready",
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("unexpected"),
    };

    await expect(ensureRedisReady(client)).rejects.toThrow(
      "Redis did not return PONG",
    );
  });
});

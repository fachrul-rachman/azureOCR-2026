import { describe, expect, it } from "vitest";

import {
  RedisAzureRateLimiter,
  type RateLimitRedis,
} from "../src/infrastructure/azure/redis-azure-rate-limiter.js";

class SharedRateLimitRedis implements RateLimitRedis {
  readonly expiresAt = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  setIfAbsent(key: string, ttlMs: number): Promise<boolean> {
    const expiry = this.expiresAt.get(key) ?? 0;
    if (expiry > this.now()) return Promise.resolve(false);
    this.expiresAt.set(key, this.now() + ttlMs);
    return Promise.resolve(true);
  }

  ttl(key: string): Promise<number> {
    return Promise.resolve(
      Math.max(0, (this.expiresAt.get(key) ?? 0) - this.now()),
    );
  }
}

describe("global Azure rate limiter", () => {
  it("spaces calls from separate worker instances through shared Redis state", async () => {
    let now = 0;
    const redis = new SharedRateLimitRedis(() => now);
    const observed: number[] = [];
    const sleep = (milliseconds: number) => {
      now += milliseconds;
      return Promise.resolve();
    };
    const firstWorker = new RedisAzureRateLimiter(redis, 1, 1, sleep);
    const secondWorker = new RedisAzureRateLimiter(redis, 1, 1, sleep);

    await firstWorker.acquire("submit");
    observed.push(now);
    await secondWorker.acquire("submit");
    observed.push(now);

    expect(observed).toEqual([0, 1_000]);
  });

  it("keeps submit and polling limits independent", async () => {
    const redis = new SharedRateLimitRedis(() => 0);
    const limiter = new RedisAzureRateLimiter(redis, 1, 1, () =>
      Promise.resolve(),
    );

    await limiter.acquire("submit");
    await limiter.acquire("poll");

    expect(redis.expiresAt.size).toBe(2);
  });
});

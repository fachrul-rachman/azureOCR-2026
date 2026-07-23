import type { Redis } from "ioredis";

import type {
  AzureRateLimitOperation,
  AzureRateLimiter,
} from "./azure-document-intelligence-adapter.js";

export interface RateLimitRedis {
  setIfAbsent(key: string, ttlMs: number): Promise<boolean>;
  ttl(key: string): Promise<number>;
}

export class IoredisRateLimitStore implements RateLimitRedis {
  constructor(private readonly redis: Redis) {}

  async setIfAbsent(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK";
  }

  ttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class RedisAzureRateLimiter implements AzureRateLimiter {
  constructor(
    private readonly redis: RateLimitRedis,
    submitRequestsPerSecond: number,
    pollRequestsPerSecond: number,
    private readonly sleep: (
      milliseconds: number,
    ) => Promise<void> = defaultSleep,
    private readonly keyPrefix = "ocr:azure:rate-limit",
  ) {
    this.intervals = {
      submit: Math.ceil(1_000 / submitRequestsPerSecond),
      poll: Math.ceil(1_000 / pollRequestsPerSecond),
    };
  }

  private readonly intervals: Record<AzureRateLimitOperation, number>;

  async acquire(operation: AzureRateLimitOperation): Promise<void> {
    const key = `${this.keyPrefix}:${operation}`;
    const interval = this.intervals[operation];

    while (!(await this.redis.setIfAbsent(key, interval))) {
      const ttl = await this.redis.ttl(key);
      await this.sleep(Math.max(1, ttl));
    }
  }
}

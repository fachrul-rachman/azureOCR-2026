import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../src/infrastructure/rate-limit/fixed-window-rate-limiter.js";

describe("API rate limiter", () => {
  it("allows requests up to the limit and reports when to retry", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, 60_000, () => now);

    expect(limiter.consume("key-1")).toEqual({ allowed: true });
    expect(limiter.consume("key-1")).toEqual({ allowed: true });
    expect(limiter.consume("key-1")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(limiter.consume("key-1")).toEqual({ allowed: true });
  });

  it("keeps counters independent per key", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000, () => 1_000);

    expect(limiter.consume("key-1")).toEqual({ allowed: true });
    expect(limiter.consume("key-2")).toEqual({ allowed: true });
  });
});

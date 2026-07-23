export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface WindowRecord {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowRecord>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): RateLimitResult {
    const now = this.now();
    const existing = this.windows.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }
    if (existing.count < this.limit) {
      existing.count += 1;
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1_000),
      ),
    };
  }
}

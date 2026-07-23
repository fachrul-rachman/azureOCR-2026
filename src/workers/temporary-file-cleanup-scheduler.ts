interface CleanupStorage {
  removeOlderThan(cutoffMs: number): Promise<number>;
}

interface CleanupLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export class TemporaryFileCleanupScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly storage: CleanupStorage,
    private readonly intervalMs: number,
    private readonly maxAgeMs: number,
    private readonly logger: CleanupLogger,
  ) {}

  async start(): Promise<void> {
    await this.trigger();
    this.timer = setInterval(() => {
      void this.trigger();
    }, this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.running;
  }

  private trigger(): Promise<void> {
    if (this.running !== undefined) return this.running;
    this.running = this.cleanup().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async cleanup(): Promise<void> {
    try {
      const deleted = await this.storage.removeOlderThan(
        Date.now() - this.maxAgeMs,
      );
      if (deleted > 0) {
        this.logger.info(
          { status: "cleaned", deleted_count: deleted },
          "Expired temporary files removed",
        );
      }
    } catch {
      this.logger.error(
        { error_code: "TEMP_CLEANUP_FAILED" },
        "Temporary file cleanup failed",
      );
    }
  }
}

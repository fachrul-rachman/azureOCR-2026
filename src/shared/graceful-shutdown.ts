interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

export function createGracefulShutdown(
  close: () => Promise<void>,
  logger: ShutdownLogger,
): (signal: ShutdownSignal) => Promise<void> {
  let shutdown: Promise<void> | undefined;

  return (signal) => {
    if (shutdown !== undefined) return shutdown;
    logger.info(
      { signal, status: "shutting_down" },
      "Graceful shutdown started",
    );
    shutdown = close().then(
      () => {
        logger.info(
          { signal, status: "stopped" },
          "Graceful shutdown completed",
        );
      },
      (error: unknown) => {
        logger.error(
          {
            signal,
            status: "shutdown_failed",
            error_code: "GRACEFUL_SHUTDOWN_FAILED",
          },
          "Graceful shutdown failed",
        );
        throw error;
      },
    );
    return shutdown;
  };
}

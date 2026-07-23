import {
  ensureRedisReady,
  type RedisConnection,
} from "../infrastructure/queue/redis-connection.js";

export interface WorkerLogger {
  info: (bindings: Record<string, unknown>, message: string) => void;
}

export async function prepareWorker(
  redis: RedisConnection,
  logger: WorkerLogger,
): Promise<void> {
  await ensureRedisReady(redis);
  logger.info({ status: "ready" }, "Worker connected to Redis");
}

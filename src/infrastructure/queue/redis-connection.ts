import { Redis } from "ioredis";

import type { Environment } from "../../config/environment.js";

export interface RedisConnection {
  readonly status: string;
  connect: () => Promise<unknown>;
  ping: () => Promise<string>;
}

export function createRedisConnection(
  environment: Pick<Environment, "redisHost" | "redisPort">,
): Redis {
  return new Redis({
    host: environment.redisHost,
    port: environment.redisPort,
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
  });
}

export function createWorkerRedisConnection(
  environment: Pick<Environment, "redisHost" | "redisPort">,
): Redis {
  return new Redis({
    host: environment.redisHost,
    port: environment.redisPort,
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
  });
}

export async function ensureRedisReady(
  connection: RedisConnection,
): Promise<void> {
  if (connection.status === "wait") {
    await connection.connect();
  }

  const response = await connection.ping();

  if (response !== "PONG") {
    throw new Error("Redis did not return PONG");
  }
}

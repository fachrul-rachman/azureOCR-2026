const NODE_ENVIRONMENTS = ["development", "test", "production"] as const;
const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number];
type LogLevel = (typeof LOG_LEVELS)[number];

export interface Environment {
  nodeEnv: NodeEnvironment;
  port: number;
  host: string;
  logLevel: LogLevel;
  redisHost: string;
  redisPort: number;
  tempDir: string;
}

function parsePort(
  value: string | undefined,
  name: "PORT" | "REDIS_PORT",
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return port;
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  if (value === undefined) {
    return "development";
  }

  if (!NODE_ENVIRONMENTS.some((environment) => environment === value)) {
    throw new Error("NODE_ENV is not supported");
  }

  return value as NodeEnvironment;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) {
    return "info";
  }

  if (!LOG_LEVELS.some((level) => level === value)) {
    throw new Error("LOG_LEVEL is not supported");
  }

  return value as LogLevel;
}

export function loadEnvironment(environment: NodeJS.ProcessEnv): Environment {
  const host = environment.HOST ?? "0.0.0.0";
  const redisHost = environment.REDIS_HOST ?? "127.0.0.1";

  if (host.trim().length === 0) {
    throw new Error("HOST must not be empty");
  }

  if (redisHost.trim().length === 0) {
    throw new Error("REDIS_HOST must not be empty");
  }

  return {
    nodeEnv: parseNodeEnvironment(environment.NODE_ENV),
    port: parsePort(environment.PORT, "PORT", 3000),
    host,
    logLevel: parseLogLevel(environment.LOG_LEVEL),
    redisHost,
    redisPort: parsePort(environment.REDIS_PORT, "REDIS_PORT", 6379),
    tempDir: environment.TEMP_DIR?.trim() || "./tmp",
  };
}

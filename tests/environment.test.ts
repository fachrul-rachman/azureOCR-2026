import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

describe("environment configuration", () => {
  it("uses safe local defaults", () => {
    expect(loadEnvironment({})).toEqual({
      nodeEnv: "development",
      port: 3000,
      host: "0.0.0.0",
      logLevel: "info",
      redisHost: "127.0.0.1",
      redisPort: 6379,
      tempDir: "./tmp",
    });
  });

  it("accepts supported values", () => {
    expect(
      loadEnvironment({
        NODE_ENV: "test",
        PORT: "3100",
        HOST: "127.0.0.1",
        LOG_LEVEL: "silent",
        REDIS_HOST: "redis",
        REDIS_PORT: "6380",
        TEMP_DIR: "C:/ocr-tmp",
      }),
    ).toEqual({
      nodeEnv: "test",
      port: 3100,
      host: "127.0.0.1",
      logLevel: "silent",
      redisHost: "redis",
      redisPort: 6380,
      tempDir: "C:/ocr-tmp",
    });
  });

  it.each(["0", "65536", "invalid"])("rejects invalid port %s", (port) => {
    expect(() => loadEnvironment({ PORT: port })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
  });

  it("rejects an unsupported log level", () => {
    expect(() => loadEnvironment({ LOG_LEVEL: "everything" })).toThrow(
      "LOG_LEVEL is not supported",
    );
  });

  it("rejects an invalid Redis port", () => {
    expect(() => loadEnvironment({ REDIS_PORT: "70000" })).toThrow(
      "REDIS_PORT must be an integer between 1 and 65535",
    );
  });
});

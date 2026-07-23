import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app/build-app.js";

describe("health endpoint", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.map(async (app) => app.close()));
    apps.length = 0;
  });

  it("reports that the API process is alive", async () => {
    const app = buildApp({ logger: false });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("reports ready when Redis is reachable", async () => {
    const readinessCheck = vi.fn().mockResolvedValue(undefined);
    const app = buildApp({ logger: false, readinessCheck });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(readinessCheck).toHaveBeenCalledOnce();
  });

  it("reports not ready without exposing the Redis error", async () => {
    const readinessCheck = vi
      .fn()
      .mockRejectedValue(new Error("redis://user:secret@internal:6379"));
    const app = buildApp({ logger: false, readinessCheck });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain("secret");
  });
});

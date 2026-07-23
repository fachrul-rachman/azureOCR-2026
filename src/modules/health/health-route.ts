import type { FastifyPluginCallback } from "fastify";

export interface HealthRouteOptions {
  readinessCheck: () => Promise<void>;
}

export const healthRoute: FastifyPluginCallback<HealthRouteOptions> = (
  app,
  options,
  done,
) => {
  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await options.readinessCheck();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  done();
};

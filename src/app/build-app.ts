import Fastify from "fastify";

import {
  createLoggerOptions,
  type LoggerOptions,
} from "../infrastructure/logger/logger-options.js";
import { healthRoute } from "../modules/health/health-route.js";
import { jobRoutes, type JobRouteOptions } from "../modules/jobs/job-routes.js";

export interface BuildAppOptions {
  logger?: false | LoggerOptions;
  readinessCheck?: () => Promise<void>;
  jobs?: JobRouteOptions;
}

const alwaysReady = (): Promise<void> => Promise.resolve();

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: options.logger ?? createLoggerOptions("info"),
  });

  app.register(healthRoute, {
    readinessCheck: options.readinessCheck ?? alwaysReady,
  });

  if (options.jobs !== undefined) {
    app.register(jobRoutes, options.jobs);
  }

  return app;
}

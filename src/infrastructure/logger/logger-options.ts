import type { Environment } from "../../config/environment.js";

export interface LoggerOptions {
  level: Environment["logLevel"];
  redact: string[];
}

export function createLoggerOptions(
  level: Environment["logLevel"],
): LoggerOptions {
  return {
    level,
    redact: [
      "req.headers.authorization",
      "req.headers.x-api-key",
      "request.headers.authorization",
      "request.headers.x-api-key",
      "*.headers.ocp-apim-subscription-key",
      "*.headers.Ocp-Apim-Subscription-Key",
      "*.azure_key",
      "*.azureKey",
    ],
  };
}

import { describe, expect, it } from "vitest";

import { createLoggerOptions } from "../src/infrastructure/logger/logger-options.js";

describe("logger configuration", () => {
  it("uses the configured level and hides authentication headers", () => {
    const options = createLoggerOptions("warn");

    expect(options.level).toBe("warn");
    expect(options.redact).toContain("req.headers.authorization");
    expect(options.redact).toContain("req.headers.x-api-key");
    expect(options.redact).toContain("*.headers.ocp-apim-subscription-key");
    expect(options.redact).toContain("*.azure_key");
  });
});

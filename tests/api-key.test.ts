import { describe, expect, it } from "vitest";

import { isValidApiKey } from "../src/modules/jobs/api-key.js";

describe("API key comparison", () => {
  it("accepts an exact match", () => {
    expect(isValidApiKey("secret", "secret")).toBe(true);
  });

  it("rejects a different value", () => {
    expect(isValidApiKey("different", "secret")).toBe(false);
  });

  it("rejects missing or repeated headers", () => {
    expect(isValidApiKey(undefined, "secret")).toBe(false);
    expect(isValidApiKey(["secret"], "secret")).toBe(false);
  });
});

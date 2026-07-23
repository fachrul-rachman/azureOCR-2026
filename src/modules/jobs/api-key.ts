import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isValidApiKey(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string") {
    return false;
  }

  return timingSafeEqual(digest(provided), digest(expected));
}

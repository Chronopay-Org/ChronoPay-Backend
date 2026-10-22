import { createHash, timingSafeEqual } from "node:crypto";

/** Compare strings without leaking their length or the position of a mismatch. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

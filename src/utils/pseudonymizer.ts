// src/utils/pseudonymizer.ts
/**
 * GDPR‑compliant deterministic pseudonymizer.
 * Uses HMAC‑SHA256 with a server‑side secret to produce a stable pseudonym.
 * The output is a URL‑safe base64 string, suitable for storage in place of PII.
 */
import crypto from "crypto";

// In production this secret should be loaded from a secure env var.
const SECRET = process.env.PSEUDONYMIZER_SECRET ?? "change-me-to-secure-secret";

/**
 * Returns a deterministic pseudonym for the given value.
 * If the value is already a pseudonym (i.e. matches the algorithm output format),
 * it is returned unchanged – this makes the erasure operation idempotent.
 */
export function pseudonymize(value: string): string {
  if (!value) return value;
  if (isPseudonymized(value)) return value;
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(value);
  // Use url‑safe base64 without padding
  return hmac.digest("base64url");
}

/**
 * Detects whether a string looks like a pseudonym produced by {@link pseudonymize}.
 * The algorithm produces only URL‑safe base64 characters and a fixed length (43).
 */
export function isPseudonymized(value: string): boolean {
  // SHA‑256 base64url without padding is 43 characters
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

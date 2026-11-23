// src/utils/pseudonymizer.ts
/**
 * GDPR‑compliant deterministic pseudonymizer.
 * Uses HMAC‑SHA256 with a server‑side secret to produce a stable pseudonym.
 * Pseudonyms are emitted with a versioned prefix (`ps1_`) so that only values
 * produced by this module are recognised as already pseudonymized.
 */
import crypto from "crypto";

// In production this secret should be loaded from a secure env var.
const SECRET = process.env.PSEUDONYMIZER_SECRET ?? "change-me-to-secure-secret";

/** Versioned prefix marking a value as a pseudonym produced by {@link pseudonymize}. */
export const PSEUDONYM_PREFIX = "ps1_";

const PSEUDONYM_BODY_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Legacy pseudonyms (emitted before the prefix was introduced) that are
 * explicitly allow-listed for recognition. Values are never recognised by shape
 * alone; add known legacy pseudonyms here only via a reviewed migration.
 */
export const LEGACY_PSEUDONYM_MIGRATION_LIST: ReadonlySet<string> = new Set<string>();

/**
 * Returns a deterministic pseudonym for the given value.
 * If the value is already a pseudonym produced by this module, it is returned
 * unchanged – this makes the erasure operation idempotent.
 */
export function pseudonymize(value: string): string {
  if (!value) return value;
  if (isPseudonymized(value)) return value;
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(value);
  // Use url‑safe base64 without padding
  return PSEUDONYM_PREFIX + hmac.digest("base64url");
}

/**
 * Detects whether a string is a pseudonym produced by {@link pseudonymize}.
 * Requires the versioned prefix; a bare 43‑character value is NOT treated as
 * pseudonymized. Legacy un‑prefixed pseudonyms are recognised only if they are
 * present in {@link LEGACY_PSEUDONYM_MIGRATION_LIST}.
 */
export function isPseudonymized(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.startsWith(PSEUDONYM_PREFIX)) {
    return PSEUDONYM_BODY_RE.test(value.slice(PSEUDONYM_PREFIX.length));
  }
  return LEGACY_PSEUDONYM_MIGRATION_LIST.has(value);
}

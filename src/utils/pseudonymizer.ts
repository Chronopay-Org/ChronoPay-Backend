// src/utils/pseudonymizer.ts
/**
 * GDPR‑compliant deterministic pseudonymizer.
 * Uses HMAC‑SHA256 with a server‑side secret to produce a stable pseudonym.
 * Pseudonyms are emitted with a versioned prefix (`ps1_`) so that only values
 * produced by this module are recognised as already pseudonymized.
 */
import crypto from "crypto";

/**
 * Placeholder secret used ONLY outside production (development & test).
 * In production a real secret of at least {@link MIN_SECRET_LENGTH} characters
 * must be provided via the `PSEUDONYMIZER_SECRET` environment variable.
 */
const DEV_FALLBACK_SECRET = "change-me-to-secure-secret";

/** Minimum acceptable secret length in production. */
const MIN_SECRET_LENGTH = 32;

/**
 * Lazily resolves the HMAC secret from the `PSEUDONYMIZER_SECRET` env var.
 *
 * **Production (`NODE_ENV=production`)** — throws when the secret is:
 *   - unset / empty,
 *   - the placeholder {@link DEV_FALLBACK_SECRET}, or
 *   - shorter than {@link MIN_SECRET_LENGTH} characters.
 *
 * **Development / test** — falls back to {@link DEV_FALLBACK_SECRET} so that
 * local development and the test suite work without extra configuration.
 *
 * The secret is resolved on every call (not at import time) so that the
 * production guard fires on first use rather than at module load.
 */
export function getSecret(): string {
  const envSecret = process.env.PSEUDONYMIZER_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    if (envSecret === undefined || envSecret.trim().length === 0) {
      throw new Error(
        "PSEUDONYMIZER_SECRET must be set in production. " +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    if (envSecret === DEV_FALLBACK_SECRET) {
      throw new Error(
        "PSEUDONYMIZER_SECRET must not be the default placeholder in production. " +
          "Set a unique secret of at least 32 characters.",
      );
    }
    if (envSecret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `PSEUDONYMIZER_SECRET must be at least ${MIN_SECRET_LENGTH} characters long in production ` +
          `(got ${envSecret.length}).`,
      );
    }
    return envSecret;
  }

  // Development / test — use the provided secret or the clearly-labelled fallback.
  return envSecret && envSecret.trim().length > 0 ? envSecret : DEV_FALLBACK_SECRET;
}

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
  const hmac = crypto.createHmac("sha256", getSecret());
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

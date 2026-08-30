import crypto from "crypto";

/**
 * RFC 6238 TOTP (Time-based One-Time Password) primitives.
 *
 * Pure Node crypto (HMAC-SHA1) + RFC 4648 base32 — no third-party deps.
 *
 * Core invariants relied on by the rest of the MFA feature:
 *  - `verifyTotpCode` returns the *matched counter step* (not a boolean) so the
 *    caller can enforce replay protection by advancing a last-used counter.
 *  - All functions are deterministic and pure given the same inputs, which
 *    keeps them trivially testable.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_ALGORITHM = "sha1" as const;
/** Size in bytes of a newly generated TOTP secret (160-bit, matches RFC 4226). */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: "sha1";
}

/** Generates a cryptographically random TOTP secret. */
export function generateTotpSecret(bytes: number = TOTP_SECRET_BYTES): Buffer {
  if (!Number.isInteger(bytes) || bytes < 10 || bytes > 64) {
    throw new RangeError("TOTP secret size must be an integer between 10 and 64 bytes");
  }
  return crypto.randomBytes(bytes);
}

/** RFC 4648 base32 encoding (no padding), as used for authenticator apps. */
export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * RFC 4648 base32 decoding. Tolerates padding, lowercase, and spaces (many
 * authenticator apps accept user-pasted codes/secrets that contain them).
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[=\s]/g, "").toUpperCase();
  if (cleaned.length === 0) {
    throw new Error("base32 input must not be empty");
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** Number of the time window (counter step) covering a given timestamp. */
export function totpCounter(timestampMs: number, period: number = TOTP_PERIOD_SECONDS): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError("period must be a positive integer");
  }
  return Math.floor(timestampMs / 1000 / period);
}

/** Computes the TOTP code for a secret at a given counter step (RFC 6238). */
export function generateTotpCode(
  secret: Buffer,
  counter: number,
  options: TotpOptions = {},
): string {
  const digits = options.digits ?? TOTP_DIGITS;
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new RangeError("digits must be between 6 and 10");
  }
  if (!Number.isInteger(counter) || counter < 0) {
    throw new RangeError("counter must be a non-negative integer");
  }

  // Counter is 8-byte big-endian (RFC 4226 §5.1).
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(TOTP_ALGORITHM, secret);
  hmac.update(counterBuffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte selects
  // a 4-byte window; the 31-bit value is reduced modulo 10^digits.
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  const modulus = 10 ** digits;

  return String(code % modulus).padStart(digits, "0");
}

/**
 * Validates a submitted TOTP code against current time.
 *
 * Checks `code` for each counter step in `[current - skew, current + skew]`
 * to absorb client/server clock drift. Returns the matched counter step (so
 * callers can advance replay state) or `null` when no step matches.
 *
 * @param secret - the raw TOTP secret bytes
 * @param code - the submitted code string
 * @param options - digits/period plus accepted clock-skew windows
 * @param nowMs - reference timestamp in ms (injectable for tests)
 */
export function verifyTotpCode(
  secret: Buffer,
  code: string,
  options: TotpOptions & { window?: number } = {},
  nowMs: number = Date.now(),
): number | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const period = options.period ?? TOTP_PERIOD_SECONDS;
  const window = options.window ?? 1;

  if (!Number.isInteger(window) || window < 0 || window > 10) {
    throw new RangeError("window must be an integer between 0 and 10");
  }
  if (typeof code !== "string" || !/^\d{6,10}$/.test(code.trim())) {
    return null;
  }

  const current = totpCounter(nowMs, period);
  for (let step = current - window; step <= current + window; step += 1) {
    if (generateTotpCode(secret, step, { digits, period }) === code.trim()) {
      return step;
    }
  }

  return null;
}

/**
 * Builds the standard `otpauth://` URI used to render a QR code for
 * authenticator apps (Google Authenticator, Authy, 1Password, etc.).
 */
export function buildOtpauthUri(
  issuer: string,
  accountName: string,
  secretBase32: string,
  options: TotpOptions & { issuer?: string } = {},
): string {
  const digits = options.digits ?? TOTP_DIGITS;
  const period = options.period ?? TOTP_PERIOD_SECONDS;
  const label = encodeURIComponent(`${issuer}:${accountName}`).replace(/%20/g, "+");
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}
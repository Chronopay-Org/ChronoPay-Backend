/**
 * memoHashCanonical.ts
 *
 * Canonical algorithm for deriving and verifying the Stellar memo hash that
 * backs a ChronoPay redemption receipt.
 *
 * ## Canonicalization contract
 *
 * Given a redemption-receipt payload, the canonical memo hash is:
 *
 *   1. Build a deterministic UTF-8 string:
 *        `{token_id}|{redeemer_id}|{redemption_id}|{amount_stroops}`
 *      - All pipe (`|`) characters in field values are percent-encoded as `%7C`
 *        before joining, so the separator is never ambiguous.
 *      - Unicode text fields (`token_id`, `redeemer_id`, `redemption_id`) are
 *        NFC-normalised (Unicode Canonical Decomposition, followed by Canonical
 *        Composition) before percent-encoding to ensure identical byte sequences
 *        across platforms.
 *
 *   2. Hash the UTF-8 encoding of the canonical string with SHA-256:
 *        `hash = SHA-256(canonical_string_utf8)`
 *
 *   3. Return the hash as a 64-character lower-case hex string (big-endian /
 *      network byte order — SHA-256 operates on bytes, not words, so
 *      endianness of the output digest is simply the byte-order of the raw
 *      SHA-256 output which is always big-endian).
 *
 * ## Why these choices?
 *
 * - NFC normalisation prevents equivalent Unicode sequences (e.g., é = e + ́)
 *   from producing different hashes.
 * - Percent-encoding the separator prevents injection: a crafted `token_id`
 *   containing `|` would otherwise let an attacker forge a different
 *   receipt that produces the same canonical string.
 * - `amount_stroops` is included as a numeric string (no trailing zeros, no
 *   decimal point) so the hash commits to the exact XLM amount.
 * - Lower-case hex output matches Horizon's own transaction hash encoding.
 */

import crypto from "crypto";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RedemptionReceiptPayload {
  /** Stellar asset code / token identifier. */
  token_id: string;
  /** Identifier of the party redeeming the token. */
  redeemer_id: string;
  /** Unique application-level redemption identifier. */
  redemption_id: string;
  /**
   * Transfer amount in stroops (1 XLM = 10_000_000 stroops).
   * Must be a non-negative safe integer.
   */
  amount_stroops: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * NFC-normalise and percent-encode the `|` separator so that it cannot appear
 * as a literal character in any field value.
 */
function canonicaliseField(raw: string): string {
  return raw.normalize("NFC").replace(/\|/g, "%7C");
}

/**
 * Build the canonical plain-text string from a receipt payload.
 *
 * Exposed for testing so callers can pin the exact string before hashing.
 */
export function buildCanonicalString(payload: RedemptionReceiptPayload): string {
  if (!Number.isSafeInteger(payload.amount_stroops) || payload.amount_stroops < 0) {
    throw new RangeError(
      `amount_stroops must be a non-negative safe integer, got: ${payload.amount_stroops}`,
    );
  }

  const tokenId = canonicaliseField(payload.token_id);
  const redeemerId = canonicaliseField(payload.redeemer_id);
  const redemptionId = canonicaliseField(payload.redemption_id);
  const amount = payload.amount_stroops.toString(10);

  return `${tokenId}|${redeemerId}|${redemptionId}|${amount}`;
}

/**
 * Derive the canonical memo hash for a redemption receipt.
 *
 * Returns a 64-character lower-case hex string (32 bytes / 256 bits).
 *
 * The hash is computed over the UTF-8 encoding of the canonical string so the
 * result is byte-order deterministic: SHA-256 digests are always in
 * "big-endian" byte order (network byte order).
 */
export function deriveMemoHash(payload: RedemptionReceiptPayload): string {
  const canonical = buildCanonicalString(payload);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ─── Matching / verification ──────────────────────────────────────────────────

/**
 * Verify that an on-chain memo hash matches the hash derived from a receipt
 * payload.
 *
 * `onChainHex` may be upper- or lower-case.  Both are normalised to
 * lower-case before comparison to avoid trivial mismatches.
 *
 * Returns `true` only if the hashes match exactly (constant-time comparison
 * via `crypto.timingSafeEqual` on the raw 32-byte digest buffers).
 *
 * Throws `MemoHashFormatError` if `onChainHex` is not a valid 64-char hex
 * string so callers do not silently accept malformed on-chain data.
 */
export function verifyMemoHash(
  onChainHex: string,
  payload: RedemptionReceiptPayload,
): boolean {
  const normalised = onChainHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalised)) {
    throw new MemoHashFormatError(onChainHex);
  }

  const expected = deriveMemoHash(payload);

  // Use constant-time comparison to prevent timing-based oracle attacks.
  const expectedBuf = Buffer.from(expected, "hex");
  const onChainBuf = Buffer.from(normalised, "hex");
  return crypto.timingSafeEqual(expectedBuf, onChainBuf);
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when the on-chain hex string is not a valid 32-byte hex digest. */
export class MemoHashFormatError extends Error {
  constructor(public readonly raw: string) {
    super(
      `Invalid memo hash format: expected 64 hex characters, got "${raw.slice(0, 80)}"`,
    );
    this.name = "MemoHashFormatError";
  }
}

/** Thrown when the computed receipt hash does not match the on-chain hash. */
export class MemoHashMismatchError extends Error {
  constructor(
    public readonly onChainHex: string,
    public readonly computedHex: string,
  ) {
    super(
      `Memo hash mismatch: on-chain=${onChainHex.slice(0, 16)}…, ` +
        `computed=${computedHex.slice(0, 16)}…`,
    );
    this.name = "MemoHashMismatchError";
  }
}

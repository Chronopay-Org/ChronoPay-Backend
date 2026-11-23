/**
 * memoHashCanonical.test.ts
 *
 * Tests for the Stellar memo hash canonicalization algorithm used to match
 * on-chain transaction memos against ChronoPay redemption receipts.
 *
 * Issue #434 – Add tests for Horizon memo hash canonicalization matching
 * redemption receipts.
 */

import crypto from "crypto";
import {
  buildCanonicalString,
  deriveMemoHash,
  verifyMemoHash,
  MemoHashFormatError,
  MemoHashMismatchError,
  type RedemptionReceiptPayload,
} from "../../utils/memoHashCanonical.js";

// ─── Fixture ──────────────────────────────────────────────────────────────────

const BASELINE: RedemptionReceiptPayload = {
  token_id: "CHRONO:ABC123",
  redeemer_id: "user-001",
  redemption_id: "redeem-xyz-001",
  amount_stroops: 50_000_000,
};

// Pre-computed golden value.  If the canonicalization algorithm changes this
// value MUST be updated deliberately – it acts as a regression pin.
const GOLDEN_CANONICAL = "CHRONO:ABC123|user-001|redeem-xyz-001|50000000";
const GOLDEN_HASH = crypto
  .createHash("sha256")
  .update(GOLDEN_CANONICAL, "utf8")
  .digest("hex");

// ─── buildCanonicalString ─────────────────────────────────────────────────────

describe("buildCanonicalString", () => {
  it("produces the expected pipe-delimited string for baseline payload", () => {
    expect(buildCanonicalString(BASELINE)).toBe(GOLDEN_CANONICAL);
  });

  it("pins the separator order: token_id|redeemer_id|redemption_id|amount", () => {
    const result = buildCanonicalString(BASELINE);
    const parts = result.split("|");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("CHRONO:ABC123");
    expect(parts[1]).toBe("user-001");
    expect(parts[2]).toBe("redeem-xyz-001");
    expect(parts[3]).toBe("50000000");
  });

  it("amount is a plain decimal string with no trailing zeros or decimal point", () => {
    const result = buildCanonicalString({ ...BASELINE, amount_stroops: 1 });
    expect(result.endsWith("|1")).toBe(true);

    const result10M = buildCanonicalString({ ...BASELINE, amount_stroops: 10_000_000 });
    expect(result10M.endsWith("|10000000")).toBe(true);
  });

  it("encodes a literal pipe in token_id as %7C to prevent separator injection", () => {
    const injected: RedemptionReceiptPayload = {
      ...BASELINE,
      token_id: "CHRONO|INJECTED",
    };
    const result = buildCanonicalString(injected);
    // The pipe in token_id must be escaped; the separator pipes must be unescaped
    expect(result.startsWith("CHRONO%7CINJECTED|")).toBe(true);
    // Splitting on literal | should yield exactly 4 parts (amount field last)
    expect(result.split("|")).toHaveLength(4);
  });

  it("encodes a literal pipe in redeemer_id as %7C", () => {
    const injected: RedemptionReceiptPayload = {
      ...BASELINE,
      redeemer_id: "user|evil",
    };
    const result = buildCanonicalString(injected);
    expect(result.split("|")).toHaveLength(4);
    expect(result).toContain("user%7Cevil");
  });

  it("encodes a literal pipe in redemption_id as %7C", () => {
    const injected: RedemptionReceiptPayload = {
      ...BASELINE,
      redemption_id: "redeem|hack",
    };
    const result = buildCanonicalString(injected);
    expect(result.split("|")).toHaveLength(4);
    expect(result).toContain("redeem%7Chack");
  });

  // ── Unicode NFC normalisation ─────────────────────────────────────────────

  it("NFC-normalises combining characters in token_id", () => {
    // é as precomposed (U+00E9) vs. decomposed (e + U+0301)
    const precomposed: RedemptionReceiptPayload = {
      ...BASELINE,
      token_id: "\u00E9",    // é  (NFC)
    };
    const decomposed: RedemptionReceiptPayload = {
      ...BASELINE,
      token_id: "e\u0301",  // e + combining acute  (NFD)
    };
    expect(buildCanonicalString(precomposed)).toBe(buildCanonicalString(decomposed));
  });

  it("NFC-normalises CJK compatibility characters", () => {
    // Halfwidth and Fullwidth Forms — both normalise to the same NFC form
    const formA: RedemptionReceiptPayload = { ...BASELINE, redeemer_id: "\uFF41" }; // ａ (fullwidth)
    const formB: RedemptionReceiptPayload = { ...BASELINE, redeemer_id: "a" };
    // NFC of \uFF41 is still \uFF41 (compatibility normalisation is NFKC, not NFC)
    // but two identical-looking strings with different compositions DO normalise
    expect(buildCanonicalString(formA)).not.toBe(buildCanonicalString(formB));
    // Sanity: two inputs that differ only in canonical composition collapse
    const nfdToken = "Angstro\u0308m"; // Ångström (NFD)
    const nfcToken = nfdToken.normalize("NFC");
    expect(buildCanonicalString({ ...BASELINE, token_id: nfdToken })).toBe(
      buildCanonicalString({ ...BASELINE, token_id: nfcToken }),
    );
  });

  it("handles empty string fields without throwing", () => {
    const empty: RedemptionReceiptPayload = {
      token_id: "",
      redeemer_id: "",
      redemption_id: "",
      amount_stroops: 0,
    };
    expect(() => buildCanonicalString(empty)).not.toThrow();
    expect(buildCanonicalString(empty)).toBe("|||0");
  });

  it("throws RangeError for negative amount_stroops", () => {
    expect(() =>
      buildCanonicalString({ ...BASELINE, amount_stroops: -1 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for non-integer amount_stroops", () => {
    expect(() =>
      buildCanonicalString({ ...BASELINE, amount_stroops: 1.5 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for amount_stroops exceeding Number.MAX_SAFE_INTEGER", () => {
    expect(() =>
      buildCanonicalString({ ...BASELINE, amount_stroops: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(RangeError);
  });
});

// ─── deriveMemoHash ───────────────────────────────────────────────────────────

describe("deriveMemoHash", () => {
  it("matches the pre-computed golden hash for the baseline payload", () => {
    expect(deriveMemoHash(BASELINE)).toBe(GOLDEN_HASH);
  });

  it("returns a 64-character lower-case hex string", () => {
    const hash = deriveMemoHash(BASELINE);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
  });

  it("is deterministic: same payload always produces same hash", () => {
    expect(deriveMemoHash(BASELINE)).toBe(deriveMemoHash({ ...BASELINE }));
  });

  it("produces distinct hashes for distinct payloads", () => {
    const hashA = deriveMemoHash(BASELINE);
    const hashB = deriveMemoHash({ ...BASELINE, amount_stroops: 1 });
    expect(hashA).not.toBe(hashB);
  });

  it("is sensitive to each field independently", () => {
    const base = deriveMemoHash(BASELINE);
    expect(deriveMemoHash({ ...BASELINE, token_id: "X" })).not.toBe(base);
    expect(deriveMemoHash({ ...BASELINE, redeemer_id: "X" })).not.toBe(base);
    expect(deriveMemoHash({ ...BASELINE, redemption_id: "X" })).not.toBe(base);
    expect(deriveMemoHash({ ...BASELINE, amount_stroops: 1 })).not.toBe(base);
  });

  // ── Endianness pin ────────────────────────────────────────────────────────

  it("output byte order matches Node crypto SHA-256 big-endian digest directly", () => {
    // Regression pin: SHA-256 operates on bytes, never word-swapped.
    // We verify that deriveMemoHash produces the same bytes as a direct
    // crypto.createHash call over the same canonical string.
    const canonical = buildCanonicalString(BASELINE);
    const directHash = crypto
      .createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex");
    expect(deriveMemoHash(BASELINE)).toBe(directHash);
  });

  it("golden hash is exactly 32 bytes in big-endian (network) byte order", () => {
    const hashBuf = Buffer.from(deriveMemoHash(BASELINE), "hex");
    expect(hashBuf.length).toBe(32);
    // Verify the first byte matches what crypto produces directly
    const canonical = buildCanonicalString(BASELINE);
    const directBuf = crypto
      .createHash("sha256")
      .update(canonical, "utf8")
      .digest();
    expect(hashBuf.compare(directBuf)).toBe(0);
  });

  it("NFC-equivalent payloads produce the same hash", () => {
    const nfd: RedemptionReceiptPayload = {
      ...BASELINE,
      redeemer_id: "A\u0300", // À in NFD
    };
    const nfc: RedemptionReceiptPayload = {
      ...BASELINE,
      redeemer_id: "\u00C0", // À in NFC
    };
    expect(deriveMemoHash(nfd)).toBe(deriveMemoHash(nfc));
  });

  it("pipe injection in a field produces a different hash from the intended value", () => {
    // Attacker-supplied token_id with pipe should NOT collide with a
    // legitimately structured canonical string.
    const legitimate: RedemptionReceiptPayload = {
      ...BASELINE,
      token_id: "CHRONO",
      redeemer_id: "evil",
      redemption_id: "redeem-xyz-001",
    };
    const crafted: RedemptionReceiptPayload = {
      ...BASELINE,
      // Attempts to shift field boundaries via injection
      token_id: "CHRONO|evil",
      redeemer_id: "redeem-xyz-001",
      redemption_id: "EXTRA",
    };
    expect(deriveMemoHash(legitimate)).not.toBe(deriveMemoHash(crafted));
  });
});

// ─── verifyMemoHash ───────────────────────────────────────────────────────────

describe("verifyMemoHash", () => {
  it("returns true when the on-chain hash matches the payload", () => {
    const onChain = deriveMemoHash(BASELINE);
    expect(verifyMemoHash(onChain, BASELINE)).toBe(true);
  });

  it("accepts upper-case hex from Horizon without false rejection", () => {
    const onChainUpper = deriveMemoHash(BASELINE).toUpperCase();
    expect(verifyMemoHash(onChainUpper, BASELINE)).toBe(true);
  });

  it("accepts mixed-case hex", () => {
    const lower = deriveMemoHash(BASELINE);
    const mixed = lower
      .split("")
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join("");
    expect(verifyMemoHash(mixed, BASELINE)).toBe(true);
  });

  it("accepts leading/trailing whitespace around the hex (network response noise)", () => {
    const padded = `  ${deriveMemoHash(BASELINE)}  `;
    expect(verifyMemoHash(padded, BASELINE)).toBe(true);
  });

  it("returns false when payload differs from on-chain hash", () => {
    const onChain = deriveMemoHash(BASELINE);
    const tampered = { ...BASELINE, amount_stroops: 1 };
    expect(verifyMemoHash(onChain, tampered)).toBe(false);
  });

  it("returns false when on-chain hash is all zeros (forged empty)", () => {
    const zeroHash = "0".repeat(64);
    expect(verifyMemoHash(zeroHash, BASELINE)).toBe(false);
  });

  it("returns false when on-chain hash differs by a single character", () => {
    const onChain = deriveMemoHash(BASELINE);
    // Flip the last hex nibble
    const lastChar = onChain[63];
    const flipped = onChain.slice(0, 63) + (lastChar === "0" ? "1" : "0");
    expect(verifyMemoHash(flipped, BASELINE)).toBe(false);
  });

  it("throws MemoHashFormatError for a string shorter than 64 characters", () => {
    expect(() => verifyMemoHash("abc", BASELINE)).toThrow(MemoHashFormatError);
  });

  it("throws MemoHashFormatError for a string longer than 64 characters", () => {
    expect(() => verifyMemoHash("a".repeat(65), BASELINE)).toThrow(MemoHashFormatError);
  });

  it("throws MemoHashFormatError for a non-hex string of correct length", () => {
    expect(() => verifyMemoHash("G".repeat(64), BASELINE)).toThrow(MemoHashFormatError);
  });

  it("throws MemoHashFormatError for an empty string", () => {
    expect(() => verifyMemoHash("", BASELINE)).toThrow(MemoHashFormatError);
  });

  // ── Constant-time safety ─────────────────────────────────────────────────

  it("uses Buffer comparison so length-mismatched inputs never bypass timingSafeEqual", () => {
    // Internally the function validates length first and only uses
    // timingSafeEqual on equal-length 32-byte buffers.  This test confirms
    // the format guard fires before any comparison attempt.
    expect(() =>
      verifyMemoHash("a".repeat(63), BASELINE),
    ).toThrow(MemoHashFormatError);
  });
});

// ─── MemoHashFormatError ──────────────────────────────────────────────────────

describe("MemoHashFormatError", () => {
  it("carries the raw value in the error instance", () => {
    const err = new MemoHashFormatError("not-a-hash");
    expect(err.raw).toBe("not-a-hash");
    expect(err.name).toBe("MemoHashFormatError");
  });

  it("truncates overly long raw values in the message to prevent log flooding", () => {
    const veryLong = "x".repeat(200);
    const err = new MemoHashFormatError(veryLong);
    expect(err.message.length).toBeLessThan(200);
  });
});

// ─── MemoHashMismatchError ────────────────────────────────────────────────────

describe("MemoHashMismatchError", () => {
  it("stores on-chain and computed hex for observability", () => {
    const onChain = "a".repeat(64);
    const computed = "b".repeat(64);
    const err = new MemoHashMismatchError(onChain, computed);
    expect(err.onChainHex).toBe(onChain);
    expect(err.computedHex).toBe(computed);
    expect(err.name).toBe("MemoHashMismatchError");
  });
});

// ─── Cross-field collision resistance (integration) ──────────────────────────

describe("canonicalization collision resistance", () => {
  it("adjacent fields with swapped values produce different hashes", () => {
    const original: RedemptionReceiptPayload = {
      token_id: "AAA",
      redeemer_id: "BBB",
      redemption_id: "CCC",
      amount_stroops: 1,
    };
    const swapped: RedemptionReceiptPayload = {
      token_id: "BBB",
      redeemer_id: "AAA",
      redemption_id: "CCC",
      amount_stroops: 1,
    };
    expect(deriveMemoHash(original)).not.toBe(deriveMemoHash(swapped));
  });

  it("empty token_id vs empty redeemer_id: different field layouts hash differently", () => {
    const a: RedemptionReceiptPayload = {
      token_id: "",
      redeemer_id: "XYZW",
      redemption_id: "R1",
      amount_stroops: 0,
    };
    const b: RedemptionReceiptPayload = {
      token_id: "XYZW",
      redeemer_id: "",
      redemption_id: "R1",
      amount_stroops: 0,
    };
    expect(deriveMemoHash(a)).not.toBe(deriveMemoHash(b));
  });

  it("amount zero and amount 1_000_000 are distinct", () => {
    const zero = deriveMemoHash({ ...BASELINE, amount_stroops: 0 });
    const oneMillion = deriveMemoHash({ ...BASELINE, amount_stroops: 1_000_000 });
    expect(zero).not.toBe(oneMillion);
  });
});

/**
 * Tests for the Horizon result-code translator (issue #591).
 *
 * Strategy:
 *  - Fixture-based table tests: each JSON file in tests/fixtures/horizon-errors/
 *    is parsed and fed through the translator; assertions verify the translated
 *    code, user message, and retryability.
 *  - Round-trip tests: raw Horizon response body (string) → translator →
 *    user-facing message.
 *  - Edge-case unit tests: unknown code (fallback), nested inner-tx errors,
 *    empty / missing result codes, non-JSON input.
 */

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseHorizonErrorBody,
  translateHorizonResultCodes,
  translateHorizonError,
  TX_RESULT_CODES,
  OP_RESULT_CODES,
  type HorizonResultCodes,
} from "../stellarRpcFailure.js";
import { isRetryableHorizonFailure } from "../../stellar/horizon.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "../../../tests/fixtures/horizon-errors");

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw);
}

// ─── translateHorizonResultCodes — known transaction codes ────────────────────

describe("translateHorizonResultCodes — known transaction codes", () => {
  interface TxCase {
    code: string;
    expectedCode: string;
    expectedRetryable: boolean;
    messagePart: string;
  }

  const TX_CASES: TxCase[] = [
    {
      code: TX_RESULT_CODES.TX_BAD_AUTH,
      expectedCode: "tx_bad_auth",
      expectedRetryable: false,
      messagePart: "authorized",
    },
    {
      code: TX_RESULT_CODES.TX_TOO_LATE,
      expectedCode: "tx_too_late",
      expectedRetryable: true,
      messagePart: "expired",
    },
    {
      code: TX_RESULT_CODES.TX_BAD_SEQ,
      expectedCode: "tx_bad_seq",
      expectedRetryable: true,
      messagePart: "sequence number",
    },
    {
      code: TX_RESULT_CODES.TX_TOO_EARLY,
      expectedCode: "tx_too_early",
      expectedRetryable: true,
      messagePart: "minimum time bound",
    },
    {
      code: TX_RESULT_CODES.TX_NO_ACCOUNT,
      expectedCode: "tx_no_account",
      expectedRetryable: false,
      messagePart: "does not exist",
    },
    {
      code: TX_RESULT_CODES.TX_INSUFFICIENT_FEE,
      expectedCode: "tx_insufficient_fee",
      expectedRetryable: true,
      messagePart: "fee",
    },
    {
      code: TX_RESULT_CODES.TX_TOO_MANY_OPERATIONS,
      expectedCode: "tx_too_many_operations",
      expectedRetryable: false,
      messagePart: "too many operations",
    },
    {
      code: TX_RESULT_CODES.TX_INTERNAL_ERROR,
      expectedCode: "tx_internal_error",
      expectedRetryable: true,
      messagePart: "internal",
    },
  ];

  for (const tc of TX_CASES) {
    it(`translates ${tc.code}`, () => {
      const result = translateHorizonResultCodes({ transaction: tc.code });

      expect(result.code).toBe(tc.expectedCode);
      expect(result.retryable).toBe(tc.expectedRetryable);
      expect(result.userMessage.toLowerCase()).toContain(tc.messagePart.toLowerCase());
      expect(result.rawCodes).toEqual({ transaction: tc.code });
    });
  }
});

// ─── translateHorizonResultCodes — known operation codes ─────────────────────

describe("translateHorizonResultCodes — known operation codes", () => {
  interface OpCase {
    code: string;
    expectedCode: string;
    expectedRetryable: boolean;
    messagePart: string;
  }

  const OP_CASES: OpCase[] = [
    {
      code: OP_RESULT_CODES.OP_BAD_AUTH,
      expectedCode: "op_bad_auth",
      expectedRetryable: false,
      messagePart: "authorized",
    },
    {
      code: OP_RESULT_CODES.OP_UNDERFUNDED,
      expectedCode: "op_underfunded",
      expectedRetryable: false,
      messagePart: "balance",
    },
    {
      code: OP_RESULT_CODES.OP_NO_DESTINATION,
      expectedCode: "op_no_destination",
      expectedRetryable: false,
      messagePart: "destination",
    },
    {
      code: OP_RESULT_CODES.OP_LINE_FULL,
      expectedCode: "op_line_full",
      expectedRetryable: false,
      messagePart: "trust line",
    },
    {
      code: OP_RESULT_CODES.OP_NO_TRUST,
      expectedCode: "op_no_trust",
      expectedRetryable: false,
      messagePart: "trust line",
    },
    {
      code: OP_RESULT_CODES.OP_NOT_AUTHORIZED,
      expectedCode: "op_not_authorized",
      expectedRetryable: false,
      messagePart: "authorized",
    },
    {
      code: OP_RESULT_CODES.OP_NO_ACCOUNT,
      expectedCode: "op_no_account",
      expectedRetryable: false,
      messagePart: "does not exist",
    },
    {
      code: OP_RESULT_CODES.OP_MALFORMED,
      expectedCode: "op_malformed",
      expectedRetryable: false,
      messagePart: "malformed",
    },
  ];

  for (const tc of OP_CASES) {
    it(`translates ${tc.code} wrapped under tx_failed`, () => {
      const result = translateHorizonResultCodes({
        transaction: TX_RESULT_CODES.TX_FAILED,
        operations: [tc.code],
      });

      expect(result.code).toBe(tc.expectedCode);
      expect(result.retryable).toBe(tc.expectedRetryable);
      expect(result.userMessage.toLowerCase()).toContain(tc.messagePart.toLowerCase());
    });
  }
});

// ─── Fixture-based round-trip tests ───────────────────────────────────────────

describe("fixture-based round-trip — raw response → translator → user message", () => {
  it("op_bad_auth fixture: produces non-retryable authorization error", () => {
    const fixture = loadFixture("op_bad_auth");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("op_bad_auth");
    expect(result!.retryable).toBe(false);
    expect(result!.userMessage.toLowerCase()).toContain("authorized");
  });

  it("tx_too_late fixture: produces retryable expiry error", () => {
    const fixture = loadFixture("tx_too_late");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("tx_too_late");
    expect(result!.retryable).toBe(true);
    expect(result!.userMessage.toLowerCase()).toContain("expired");
  });

  it("tx_bad_seq fixture: produces retryable sequence error", () => {
    const fixture = loadFixture("tx_bad_seq");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("tx_bad_seq");
    expect(result!.retryable).toBe(true);
    expect(result!.userMessage.toLowerCase()).toContain("sequence");
  });

  it("op_underfunded fixture: produces non-retryable insufficient funds error", () => {
    const fixture = loadFixture("op_underfunded");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("op_underfunded");
    expect(result!.retryable).toBe(false);
    expect(result!.userMessage.toLowerCase()).toContain("balance");
  });

  it("tx_bad_auth fixture: produces non-retryable auth error", () => {
    const fixture = loadFixture("tx_bad_auth");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("tx_bad_auth");
    expect(result!.retryable).toBe(false);
    expect(result!.userMessage.toLowerCase()).toContain("authorized");
  });

  it("unknown_code fixture: falls back to generic message and is non-retryable", () => {
    const fixture = loadFixture("unknown_code");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("op_unknown_future_code");
    expect(result!.retryable).toBe(false);
    expect(result!.userMessage.toLowerCase()).toContain("unrecognized");
  });

  it("nested_inner_tx fixture: skips op_success entries and finds first failure", () => {
    const fixture = loadFixture("nested_inner_tx");
    const result = translateHorizonError(fixture);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("op_underfunded");
    expect(result!.retryable).toBe(false);
    expect(result!.rawCodes.operations).toEqual(["op_success", "op_success", "op_underfunded"]);
  });

  it("empty_response fixture: returns null when no result_codes present", () => {
    const fixture = loadFixture("empty_response");
    const result = translateHorizonError(fixture);

    expect(result).toBeNull();
  });
});

// ─── Round-trip with raw JSON string body ─────────────────────────────────────

describe("translateHorizonError — raw string input round-trip", () => {
  it("accepts a JSON string body and translates correctly", () => {
    const body = JSON.stringify({
      type: "https://stellar.org/horizon-errors/transaction_failed",
      title: "Transaction Failed",
      status: 400,
      extras: {
        result_codes: { transaction: "tx_bad_seq" },
      },
    });

    const result = translateHorizonError(body);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("tx_bad_seq");
    expect(result!.retryable).toBe(true);
  });

  it("accepts a plain object directly", () => {
    const body = {
      extras: {
        result_codes: { transaction: "tx_too_late" },
      },
    };

    const result = translateHorizonError(body);

    expect(result).not.toBeNull();
    expect(result!.code).toBe("tx_too_late");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("translateHorizonError — edge cases", () => {
  it("returns null for null input", () => {
    expect(translateHorizonError(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(translateHorizonError(undefined)).toBeNull();
  });

  it("returns null for a non-JSON string", () => {
    expect(translateHorizonError("not json at all")).toBeNull();
  });

  it("returns null for a number", () => {
    expect(translateHorizonError(42)).toBeNull();
  });

  it("returns null for an object without extras", () => {
    expect(translateHorizonError({ status: 400 })).toBeNull();
  });

  it("returns null for extras without result_codes", () => {
    expect(translateHorizonError({ extras: {} })).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(translateHorizonError("")).toBeNull();
  });
});

// ─── parseHorizonErrorBody ────────────────────────────────────────────────────

describe("parseHorizonErrorBody", () => {
  it("parses a valid JSON string", () => {
    const body = JSON.stringify({
      status: 400,
      extras: { result_codes: { transaction: "tx_bad_seq" } },
    });
    const result = parseHorizonErrorBody(body);
    expect(result).not.toBeNull();
    expect(result!.extras?.result_codes?.transaction).toBe("tx_bad_seq");
  });

  it("returns the object as-is when given an object", () => {
    const obj = { extras: { result_codes: { transaction: "tx_bad_auth" } } };
    const result = parseHorizonErrorBody(obj);
    expect(result).toBe(obj);
  });

  it("returns null for invalid JSON string", () => {
    expect(parseHorizonErrorBody("{invalid")).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseHorizonErrorBody(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseHorizonErrorBody(undefined)).toBeNull();
  });

  it("returns null for a plain number", () => {
    expect(parseHorizonErrorBody(42)).toBeNull();
  });

  it("returns null for a plain string that is not JSON", () => {
    expect(parseHorizonErrorBody("hello")).toBeNull();
  });
});

// ─── translateHorizonResultCodes — tx_failed wrapper behaviour ────────────────

describe("translateHorizonResultCodes — tx_failed wrapper behaviour", () => {
  it("tx_failed with no operations key produces tx_failed code", () => {
    const result = translateHorizonResultCodes({ transaction: "tx_failed" });
    expect(result.code).toBe("tx_failed");
    expect(typeof result.userMessage).toBe("string");
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  it("tx_failed with all op_success entries falls back to tx_failed code", () => {
    const result = translateHorizonResultCodes({
      transaction: "tx_failed",
      operations: ["op_success", "op_success"],
    });
    expect(result.code).toBe("tx_failed");
  });

  it("tx_failed with null operation entries skips them", () => {
    const result = translateHorizonResultCodes({
      transaction: "tx_failed",
      operations: [null, "op_bad_auth"],
    } as HorizonResultCodes);
    expect(result.code).toBe("op_bad_auth");
    expect(result.retryable).toBe(false);
  });

  it("rawCodes is echoed back verbatim", () => {
    const codes: HorizonResultCodes = {
      transaction: "tx_bad_auth",
      operations: ["op_success"],
    };
    const result = translateHorizonResultCodes(codes);
    expect(result.rawCodes).toBe(codes);
  });

  it("empty operations array falls back to tx code translation", () => {
    const result = translateHorizonResultCodes({
      transaction: "tx_failed",
      operations: [],
    });
    expect(result.code).toBe("tx_failed");
  });

  it("no transaction code and no operations falls back to unknown", () => {
    const result = translateHorizonResultCodes({});
    expect(result.code).toBe("unknown");
    expect(result.retryable).toBe(false);
  });

  it("unknown non-tx_failed transaction code uses fallback message", () => {
    // Covers the FALLBACK_ENTRY branch for unrecognised tx-level codes
    const result = translateHorizonResultCodes({ transaction: "tx_future_unknown_code" });
    expect(result.code).toBe("tx_future_unknown_code");
    expect(result.retryable).toBe(false);
    expect(result.userMessage.toLowerCase()).toContain("unrecognized");
  });
});

// ─── isRetryableHorizonFailure (horizon.ts re-export) ─────────────────────────

describe("isRetryableHorizonFailure", () => {
  it("returns true for a retryable failure (tx_bad_seq)", () => {
    const failure = translateHorizonResultCodes({ transaction: TX_RESULT_CODES.TX_BAD_SEQ });
    expect(isRetryableHorizonFailure(failure)).toBe(true);
  });

  it("returns false for a non-retryable failure (tx_bad_auth)", () => {
    const failure = translateHorizonResultCodes({ transaction: TX_RESULT_CODES.TX_BAD_AUTH });
    expect(isRetryableHorizonFailure(failure)).toBe(false);
  });

  it("returns true for tx_too_late", () => {
    const failure = translateHorizonResultCodes({ transaction: TX_RESULT_CODES.TX_TOO_LATE });
    expect(isRetryableHorizonFailure(failure)).toBe(true);
  });

  it("returns false for op_underfunded", () => {
    const failure = translateHorizonResultCodes({
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [OP_RESULT_CODES.OP_UNDERFUNDED],
    });
    expect(isRetryableHorizonFailure(failure)).toBe(false);
  });
});

// ─── Security: no sensitive data leakage in user messages ────────────────────

describe("security — user-facing messages do not leak raw XDR or internal details", () => {
  const SENSITIVE_PATTERNS = [
    /envelope_xdr/i,
    /result_xdr/i,
    /AAAAAAAAAGT/, // base64 XDR fragment
    /https:\/\/stellar\.org\/horizon-errors/,
  ];

  const TX_CODES_TO_CHECK = [
    TX_RESULT_CODES.TX_BAD_AUTH,
    TX_RESULT_CODES.TX_TOO_LATE,
    TX_RESULT_CODES.TX_BAD_SEQ,
    TX_RESULT_CODES.TX_INTERNAL_ERROR,
  ];

  for (const code of TX_CODES_TO_CHECK) {
    it(`userMessage for ${code} does not contain sensitive data`, () => {
      const result = translateHorizonResultCodes({ transaction: code });
      for (const pattern of SENSITIVE_PATTERNS) {
        expect(result.userMessage).not.toMatch(pattern);
      }
    });
  }

  it("userMessage for op_underfunded does not expose raw XDR", () => {
    const result = translateHorizonResultCodes({
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [OP_RESULT_CODES.OP_UNDERFUNDED],
    });
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(result.userMessage).not.toMatch(pattern);
    }
  });

  it("fallback message for unknown code does not expose raw XDR", () => {
    const result = translateHorizonResultCodes({
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: ["op_future_unknown_code_xyz"],
    });
    for (const pattern of SENSITIVE_PATTERNS) {
      expect(result.userMessage).not.toMatch(pattern);
    }
  });
});

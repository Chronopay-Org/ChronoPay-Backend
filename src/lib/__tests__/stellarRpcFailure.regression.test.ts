/**
 * Regression suite for TX_RESULT_CODES failure handling — issue #1090.
 *
 * Exercises the three explicit null-return branches in translateHorizonError
 * (stellarRpcFailure.ts lines 193, 202, 207) plus boundary inputs and the
 * complete TX_RESULT_CODES enumeration contract. Each describe block maps to
 * a specific line so that future regressions are immediately locatable.
 *
 * Line reference (translateHorizonError):
 *   193 — `if (!body) return null;`     body is falsy after parseHorizonErrorBody
 *   202 — `if (!resultCodes) return null;` extras.result_codes is absent
 *   207 — `return translateHorizonResultCodes(resultCodes);` success delegation
 */

import { describe, it, expect } from "@jest/globals";
import {
  translateHorizonError,
  translateHorizonResultCodes,
  TX_RESULT_CODES,
  OP_RESULT_CODES,
  type HorizonResultCodes,
  type TranslatedHorizonFailure,
} from "../stellarRpcFailure.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Horizon 400 body with result_codes embedded. */
function buildBody(resultCodes: HorizonResultCodes): object {
  return {
    type: "https://stellar.org/horizon-errors/transaction_failed",
    title: "Transaction Failed",
    status: 400,
    extras: { result_codes: resultCodes },
  };
}

/** Assert the structural contract of every TranslatedHorizonFailure. */
function assertResultContract(result: TranslatedHorizonFailure, rawCodes: HorizonResultCodes): void {
  expect(typeof result.code).toBe("string");
  expect(result.code.length).toBeGreaterThan(0);
  expect(typeof result.userMessage).toBe("string");
  expect(result.userMessage.length).toBeGreaterThan(0);
  expect(typeof result.retryable).toBe("boolean");
  expect(result.rawCodes).toBe(rawCodes);
}

// ─── Regression: line 193 — null body branch ─────────────────────────────────
//
// translateHorizonError calls parseHorizonErrorBody first. When that returns
// null the function MUST return null immediately (line 193).

describe("regression #1090 — line 193: null body branch", () => {
  it("returns null for null input", () => {
    expect(translateHorizonError(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(translateHorizonError(undefined)).toBeNull();
  });

  it("returns null for a non-JSON string", () => {
    expect(translateHorizonError("not json")).toBeNull();
  });

  it("returns null for a truncated/broken JSON string", () => {
    expect(translateHorizonError('{"extras":')).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(translateHorizonError("")).toBeNull();
  });

  it("returns null for a number primitive", () => {
    expect(translateHorizonError(42)).toBeNull();
  });

  it("returns null for a boolean primitive", () => {
    expect(translateHorizonError(true)).toBeNull();
  });

  it("returns null for an array (not a plain error object)", () => {
    // parseHorizonErrorBody accepts objects; arrays are objects — but the
    // function should still reach the result_codes guard (line 202) and
    // return null for missing extras. This verifies no crash on array input.
    expect(translateHorizonError([])).toBeNull();
  });
});

// ─── Regression: line 202 — missing result_codes branch ──────────────────────
//
// When the body is a valid object but does NOT contain extras.result_codes,
// the function MUST return null (line 202).

describe("regression #1090 — line 202: missing result_codes branch", () => {
  it("returns null for an object with no extras key at all", () => {
    expect(translateHorizonError({ status: 400 })).toBeNull();
  });

  it("returns null for an object with an empty extras object", () => {
    expect(translateHorizonError({ extras: {} })).toBeNull();
  });

  it("returns null when extras.result_codes is explicitly undefined", () => {
    expect(translateHorizonError({ extras: { result_codes: undefined } })).toBeNull();
  });

  it("returns null when extras.result_codes is explicitly null", () => {
    // null is falsy — treated the same as absent by the guard
    expect(translateHorizonError({ extras: { result_codes: null } })).toBeNull();
  });

  it("returns null for a valid JSON string whose body lacks result_codes", () => {
    const body = JSON.stringify({
      type: "https://stellar.org/horizon-errors/transaction_failed",
      title: "Transaction Failed",
      status: 400,
      extras: { envelope_xdr: "AAAA..." }, // has extras, but no result_codes
    });
    expect(translateHorizonError(body)).toBeNull();
  });

  it("returns null when extras itself is null", () => {
    expect(translateHorizonError({ extras: null })).toBeNull();
  });
});

// ─── Regression: line 207 — success delegation path ─────────────────────────
//
// When body AND result_codes are both present, translateHorizonError MUST
// delegate to translateHorizonResultCodes and return a non-null result.

describe("regression #1090 — line 207: success delegation path", () => {
  it("returns a non-null TranslatedHorizonFailure when result_codes is present (plain object)", () => {
    const input = buildBody({ transaction: TX_RESULT_CODES.TX_BAD_SEQ });
    const result = translateHorizonError(input);

    expect(result).not.toBeNull();
  });

  it("returns a non-null TranslatedHorizonFailure when input is a JSON string", () => {
    const input = JSON.stringify(buildBody({ transaction: TX_RESULT_CODES.TX_BAD_AUTH }));
    const result = translateHorizonError(input);

    expect(result).not.toBeNull();
  });

  it("result from string input has the correct code", () => {
    const input = JSON.stringify(buildBody({ transaction: TX_RESULT_CODES.TX_TOO_LATE }));
    const result = translateHorizonError(input);

    expect(result!.code).toBe("tx_too_late");
  });

  it("result retains the rawCodes reference from the parsed body", () => {
    const codes: HorizonResultCodes = { transaction: TX_RESULT_CODES.TX_BAD_AUTH };
    const result = translateHorizonError({ extras: { result_codes: codes } });

    expect(result!.rawCodes).toEqual(codes);
  });
});

// ─── TX_RESULT_CODES enumeration contract ────────────────────────────────────
//
// Every code in TX_RESULT_CODES MUST produce a valid TranslatedHorizonFailure
// with the expected retryability. TX_FAILED is special — it is a wrapper code
// and is handled separately below.

describe("TX_RESULT_CODES enumeration contract", () => {
  interface TxContractCase {
    code: string;
    retryable: boolean;
  }

  const EXPECTED: TxContractCase[] = [
    { code: TX_RESULT_CODES.TX_BAD_AUTH, retryable: false },
    { code: TX_RESULT_CODES.TX_TOO_LATE, retryable: true },
    { code: TX_RESULT_CODES.TX_BAD_SEQ, retryable: true },
    { code: TX_RESULT_CODES.TX_TOO_EARLY, retryable: true },
    { code: TX_RESULT_CODES.TX_NO_ACCOUNT, retryable: false },
    { code: TX_RESULT_CODES.TX_INSUFFICIENT_FEE, retryable: true },
    { code: TX_RESULT_CODES.TX_TOO_MANY_OPERATIONS, retryable: false },
    { code: TX_RESULT_CODES.TX_INTERNAL_ERROR, retryable: true },
  ];

  for (const tc of EXPECTED) {
    it(`TX_RESULT_CODES.${tc.code} — retryable=${tc.retryable}, non-empty userMessage, correct rawCodes`, () => {
      const codes: HorizonResultCodes = { transaction: tc.code };
      const result = translateHorizonResultCodes(codes);

      assertResultContract(result, codes);
      expect(result.code).toBe(tc.code);
      expect(result.retryable).toBe(tc.retryable);
    });
  }

  it("every TX_RESULT_CODES value is exercised — no silent additions to the enum", () => {
    // Enumerate every value exported from TX_RESULT_CODES and confirm it maps
    // to a known entry.  If a new code is added to TX_RESULT_CODES but
    // forgotten in the EXPECTED table above, this test catches it.
    const coveredCodes = new Set(EXPECTED.map((tc) => tc.code));
    coveredCodes.add(TX_RESULT_CODES.TX_FAILED); // handled separately

    const allExportedCodes = Object.values(TX_RESULT_CODES) as string[];
    for (const code of allExportedCodes) {
      expect(coveredCodes.has(code)).toBe(true);
    }
  });
});

// ─── TX_FAILED wrapper — exhaustive behaviour ─────────────────────────────────
//
// TX_FAILED is the only tx-level code that causes translateHorizonResultCodes
// to fall through to the operation-level inspection loop.

describe("TX_RESULT_CODES.TX_FAILED — wrapper behaviour contract", () => {
  it("tx_failed with a single known op code extracts that op code", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [OP_RESULT_CODES.OP_UNDERFUNDED],
    };
    const result = translateHorizonResultCodes(codes);

    assertResultContract(result, codes);
    expect(result.code).toBe(OP_RESULT_CODES.OP_UNDERFUNDED);
    expect(result.retryable).toBe(false);
  });

  it("tx_failed with null entries before the first failure skips nulls", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [null, null, OP_RESULT_CODES.OP_NO_DESTINATION],
    } as HorizonResultCodes;
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(OP_RESULT_CODES.OP_NO_DESTINATION);
  });

  it("tx_failed with op_success entries before the first failure skips successes", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: ["op_success", "op_success", OP_RESULT_CODES.OP_BAD_AUTH],
    };
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(OP_RESULT_CODES.OP_BAD_AUTH);
    expect(result.retryable).toBe(false);
  });

  it("tx_failed with mixed nulls and op_success and real failure finds first real failure", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [null, "op_success", OP_RESULT_CODES.OP_LINE_FULL, OP_RESULT_CODES.OP_NO_TRUST],
    } as HorizonResultCodes;
    const result = translateHorizonResultCodes(codes);

    // Should return first non-success/non-null op code
    expect(result.code).toBe(OP_RESULT_CODES.OP_LINE_FULL);
  });

  it("tx_failed with all op_success operations falls back to tx_failed code", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: ["op_success", "op_success", "op_success"],
    };
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(TX_RESULT_CODES.TX_FAILED);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  it("tx_failed with all-null operations array falls back to tx_failed code", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [null, null],
    } as HorizonResultCodes;
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(TX_RESULT_CODES.TX_FAILED);
  });

  it("tx_failed with empty operations array falls back to tx_failed code", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [],
    };
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(TX_RESULT_CODES.TX_FAILED);
  });

  it("tx_failed with no operations key falls back to tx_failed code", () => {
    const codes: HorizonResultCodes = { transaction: TX_RESULT_CODES.TX_FAILED };
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe(TX_RESULT_CODES.TX_FAILED);
  });

  it("tx_failed wrapping an unknown op code uses fallback message and is non-retryable", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: ["op_future_unknown_xyz"],
    };
    const result = translateHorizonResultCodes(codes);

    expect(result.code).toBe("op_future_unknown_xyz");
    expect(result.retryable).toBe(false);
    expect(result.userMessage.toLowerCase()).toContain("unrecognized");
  });

  it("rawCodes is echoed verbatim on tx_failed path", () => {
    const codes: HorizonResultCodes = {
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [OP_RESULT_CODES.OP_MALFORMED],
    };
    const result = translateHorizonResultCodes(codes);

    expect(result.rawCodes).toBe(codes);
  });

  it("full translateHorizonError round-trip for tx_failed + op_underfunded", () => {
    const body = buildBody({
      transaction: TX_RESULT_CODES.TX_FAILED,
      operations: [OP_RESULT_CODES.OP_UNDERFUNDED],
    });
    const result = translateHorizonError(body);

    expect(result).not.toBeNull();
    expect(result!.code).toBe(OP_RESULT_CODES.OP_UNDERFUNDED);
    expect(result!.retryable).toBe(false);
    expect(result!.userMessage.toLowerCase()).toContain("balance");
  });
});

// ─── Boundary inputs for translateHorizonResultCodes ─────────────────────────

describe("translateHorizonResultCodes — boundary inputs", () => {
  it("empty result-codes object falls back to 'unknown' code, non-retryable", () => {
    const codes: HorizonResultCodes = {};
    const result = translateHorizonResultCodes(codes);

    assertResultContract(result, codes);
    expect(result.code).toBe("unknown");
    expect(result.retryable).toBe(false);
  });

  it("transaction code that is an empty string falls back", () => {
    // Empty string is falsy — the transaction check `if (transaction && ...)` skips it
    const codes: HorizonResultCodes = { transaction: "" };
    const result = translateHorizonResultCodes(codes);

    // Falls through all branches; primaryCode is "" which has no map entry
    expect(result.retryable).toBe(false);
    expect(result.userMessage.length).toBeGreaterThan(0);
  });

  it("operations is not an array (object) — treated as if operations absent", () => {
    // TypeScript won't allow this without a cast, but runtime data from
    // Horizon may be malformed. Ensures no crash on non-array operations.
    const codes = { transaction: TX_RESULT_CODES.TX_FAILED, operations: {} } as unknown as HorizonResultCodes;
    const result = translateHorizonResultCodes(codes);

    // Array.isArray({}) is false — falls through to fallback with tx code
    expect(result.code).toBe(TX_RESULT_CODES.TX_FAILED);
  });

  it("produces a stable result when called twice with the same input (idempotency)", () => {
    const codes: HorizonResultCodes = { transaction: TX_RESULT_CODES.TX_BAD_SEQ };
    const r1 = translateHorizonResultCodes(codes);
    const r2 = translateHorizonResultCodes(codes);

    expect(r1.code).toBe(r2.code);
    expect(r1.userMessage).toBe(r2.userMessage);
    expect(r1.retryable).toBe(r2.retryable);
  });

  it("rawCodes reference is the exact object passed in, not a clone", () => {
    const codes: HorizonResultCodes = { transaction: TX_RESULT_CODES.TX_BAD_AUTH };
    const result = translateHorizonResultCodes(codes);

    expect(result.rawCodes).toBe(codes); // strict reference equality
  });
});

// ─── OP_RESULT_CODES enumeration contract ────────────────────────────────────
//
// Every code in OP_RESULT_CODES MUST be handled under a tx_failed wrapper.

describe("OP_RESULT_CODES enumeration contract — all codes under tx_failed", () => {
  const ALL_OP_CODES = Object.values(OP_RESULT_CODES) as string[];

  for (const opCode of ALL_OP_CODES) {
    it(`OP_RESULT_CODES.${opCode} — non-empty userMessage, non-retryable, correct rawCodes`, () => {
      const codes: HorizonResultCodes = {
        transaction: TX_RESULT_CODES.TX_FAILED,
        operations: [opCode],
      };
      const result = translateHorizonResultCodes(codes);

      assertResultContract(result, codes);
      expect(result.code).toBe(opCode);
      // All known op codes are non-retryable
      expect(result.retryable).toBe(false);
    });
  }
});

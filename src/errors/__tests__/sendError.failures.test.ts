/**
 * Regression suite for the failure paths in `src/errors/sendError.ts`
 * (Issue #1076).
 *
 * The failure branches are the two `throw new Error("Unknown error code: …")`
 * sites in `taxonomyEntry` / `sendError` (src/errors/sendError.ts:73 and :172)
 * and the scope-mismatch throw at :76. The existing `sendError.test.ts` samples
 * these in isolation; this fixture pins their exact contract:
 *
 * - the message names the offending code and, for scope mismatches, the scope
 *   that was actually observed,
 * - the throw is a real `Error` instance raised synchronously,
 * - a failed send never touches the response object,
 * - every code in the runtime code arrays is rejected when used in the wrong
 *   scope, so the two arrays can never drift from the taxonomy's `scope` field.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Response } from "express";
import { sendPublicError, sendInternalError, sendError } from "../sendError.js";
import {
  ERROR_TAXONOMY,
  PUBLIC_ERROR_CODES,
  INTERNAL_ERROR_CODES,
  type ErrorCode,
} from "../errorCodes.js";

function createMockResponse() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

let mockRes: ReturnType<typeof createMockResponse>;

beforeEach(() => {
  mockRes = createMockResponse();
  process.env.NODE_ENV = "development";
});

describe("sendError failure paths — unknown codes", () => {
  it("sendError throws an Error naming the unknown code", () => {
    expect(() => sendError(mockRes, "HACKER_INJECTION" as never, "attempt")).toThrow(
      "Unknown error code: HACKER_INJECTION",
    );
  });

  it("sendPublicError throws an Error naming the unknown code", () => {
    expect(() => sendPublicError(mockRes, "NOT_A_CODE" as never, "attempt")).toThrow(
      "Unknown error code: NOT_A_CODE",
    );
  });

  it("sendInternalError throws an Error naming the unknown code", () => {
    expect(() => sendInternalError(mockRes, "NOPE" as never, "attempt")).toThrow(
      "Unknown error code: NOPE",
    );
  });

  it("throws a real Error instance synchronously, not a string", () => {
    let caught: unknown;
    try {
      sendError(mockRes, "MISSING" as never, "attempt");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Unknown error code: MISSING");
  });

  it("does not touch the response when the code is unknown", () => {
    expect(() => sendError(mockRes, "MISSING" as never, "attempt")).toThrow();
    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.json).not.toHaveBeenCalled();
  });

  it("stringifies non-string runtime values in the message", () => {
    expect(() => sendError(mockRes, 42 as never, "attempt")).toThrow("Unknown error code: 42");
    expect(() => sendError(mockRes, undefined as never, "attempt")).toThrow(
      "Unknown error code: undefined",
    );
  });
});

describe("sendError failure paths — scope mismatches", () => {
  it("rejects an internal code passed to sendPublicError and reports the observed scope", () => {
    expect(() => sendPublicError(mockRes, "DB_ERROR" as never, "attempt")).toThrow(
      'Invalid public error code: DB_ERROR (got scope "internal")',
    );
  });

  it("rejects a public code passed to sendInternalError and reports the observed scope", () => {
    expect(() => sendInternalError(mockRes, "NOT_FOUND" as never, "attempt")).toThrow(
      'Invalid internal error code: NOT_FOUND (got scope "public")',
    );
  });

  it("does not touch the response when the scope is wrong", () => {
    expect(() => sendPublicError(mockRes, "DB_ERROR" as never, "attempt")).toThrow();
    expect(() => sendInternalError(mockRes, "NOT_FOUND" as never, "attempt")).toThrow();
    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.json).not.toHaveBeenCalled();
  });

  it("rejects every internal code in the public scope", () => {
    for (const code of INTERNAL_ERROR_CODES) {
      expect(() => sendPublicError(mockRes, code as never, "attempt")).toThrow(
        `Invalid public error code: ${code} (got scope "internal")`,
      );
    }
  });

  it("rejects every public code in the internal scope", () => {
    for (const code of PUBLIC_ERROR_CODES) {
      expect(() => sendInternalError(mockRes, code as never, "attempt")).toThrow(
        `Invalid internal error code: ${code} (got scope "public")`,
      );
    }
  });
});

describe("runtime code arrays stay aligned with the taxonomy scope", () => {
  it("marks every code in PUBLIC_ERROR_CODES as scope public", () => {
    for (const code of PUBLIC_ERROR_CODES) {
      expect(ERROR_TAXONOMY[code as ErrorCode].scope).toBe("public");
    }
  });

  it("marks every code in INTERNAL_ERROR_CODES as scope internal", () => {
    for (const code of INTERNAL_ERROR_CODES) {
      expect(ERROR_TAXONOMY[code as ErrorCode].scope).toBe("internal");
    }
  });

  it("the two arrays are disjoint and cover the taxonomy", () => {
    const all = [...PUBLIC_ERROR_CODES, ...INTERNAL_ERROR_CODES];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(Object.keys(ERROR_TAXONOMY)));
  });
});

describe("valid codes still succeed on the same code paths", () => {
  it("sendError routes a valid public code without throwing", () => {
    expect(() => sendError(mockRes, "NOT_FOUND", "missing")).not.toThrow();
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalled();
  });

  it("sendError routes a valid internal code without throwing", () => {
    expect(() => sendError(mockRes, "DB_ERROR", "boom")).not.toThrow();
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });
});

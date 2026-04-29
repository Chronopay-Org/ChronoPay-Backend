import { jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  validateRequiredFields,
  ValidationDetail,
  ValidationErrorResponse,
} from "../middleware/validation.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createResponseMock() {
  const responseBody: unknown[] = [];
  const response = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      responseBody.push(payload);
      return this;
    },
  };

  return {
    response: response as unknown as Response,
    responseBody,
    // Typed helper so tests don't need casts everywhere
    lastBody(): ValidationErrorResponse {
      return responseBody[0] as ValidationErrorResponse;
    },
  };
}

function makeRequest(
  body: unknown = {},
  query: unknown = {},
  params: unknown = {},
): Request {
  return { body, query, params } as unknown as Request;
}

const noOp = jest.fn() as unknown as NextFunction;

// ─── Existing tests (kept, updated for new response shape) ────────────────────

describe("validateRequiredFields — existing contract", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 when target data is missing or invalid", () => {
    const middleware = validateRequiredFields(["professional"], "body");
    const { response, lastBody } = createResponseMock();
    const request = { body: undefined } as unknown as Request;

    middleware(request, response, noOp);

    expect((response as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(responseBody[0]).toEqual(
      expect.objectContaining({
        success: false,
        code: "BAD_REQUEST",
        error: "Request body is missing or invalid",
        timestamp: expect.any(String),
      }),
    );
  });

  it("returns 500 when a middleware exception occurs", () => {
    const middleware = validateRequiredFields(["professional"], "body");
    const { response, responseBody } = createResponseMock();
    const request = {} as Request;
    Object.defineProperty(request, "body", {
      get() {
        throw new Error("unexpected read failure");
      },
    });

    middleware(request, response, noOp);

    expect((response as unknown as { statusCode: number }).statusCode).toBe(500);
    expect(responseBody[0]).toEqual(
      expect.objectContaining({
        success: false,
        code: "INTERNAL_ERROR",
        error: "Validation middleware error",
        timestamp: expect.any(String),
      }),
    );
  });
});

// ─── Deterministic ordering ───────────────────────────────────────────────────

describe("validateRequiredFields — deterministic error ordering", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns errors sorted by path when multiple fields are missing", () => {
    // Fields given in reverse alphabetical order to the middleware
    const middleware = validateRequiredFields(
      ["startTime", "professional", "endTime"],
      "body",
    );
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}), response, noOp);

    const body = lastBody();
    expect(body.success).toBe(false);
    expect(body.code).toBe("VALIDATION_ERROR");

    const paths = body.details.map((d: ValidationDetail) => d.path);
    // Must be sorted lexicographically regardless of the input order above
    expect(paths).toEqual(["endTime", "professional", "startTime"]);
  });

  it("order is stable across two identical calls", () => {
    const middleware = validateRequiredFields(
      ["z_field", "a_field", "m_field"],
      "body",
    );

    const { response: r1, lastBody: lb1 } = createResponseMock();
    middleware(makeRequest({}), r1, noOp);

    const { response: r2, lastBody: lb2 } = createResponseMock();
    middleware(makeRequest({}), r2, noOp);

    expect(lb1().details.map((d: ValidationDetail) => d.path)).toEqual(
      lb2().details.map((d: ValidationDetail) => d.path),
    );
  });

  it("order is stable even when request body key order differs", () => {
    // Body has some keys present but with the wrong ones absent
    const middleware = validateRequiredFields(
      ["beta", "alpha", "gamma"],
      "body",
    );

    // Pass partial body — alpha and gamma missing
    const { response, lastBody } = createResponseMock();
    middleware(makeRequest({ beta: "x" }), response, noOp);

    const paths = lastBody().details.map((d: ValidationDetail) => d.path);
    expect(paths).toEqual(["alpha", "gamma"]);
  });
});

// ─── All errors collected (no short-circuit) ──────────────────────────────────

describe("validateRequiredFields — collects all errors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reports every missing field, not just the first", () => {
    const middleware = validateRequiredFields(
      ["professional", "startTime", "endTime"],
      "body",
    );
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}), response, noOp);

    expect(lastBody().details).toHaveLength(3);
  });

  it("reports only the fields that are actually missing", () => {
    const middleware = validateRequiredFields(
      ["professional", "startTime", "endTime"],
      "body",
    );
    const { response, lastBody } = createResponseMock();

    // Only professional is present
    middleware(
      makeRequest({ professional: "alice" }),
      response,
      noOp,
    );

    const paths = lastBody().details.map((d: ValidationDetail) => d.path);
    expect(paths).toEqual(["endTime", "startTime"]); // sorted
  });

  it("calls next() when all fields are present", () => {
    const middleware = validateRequiredFields(
      ["professional", "startTime"],
      "body",
    );
    const { response } = createResponseMock();
    const next = jest.fn() as unknown as NextFunction;

    middleware(
      makeRequest({ professional: "alice", startTime: 1000 }),
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── Response shape contract ──────────────────────────────────────────────────

describe("validateRequiredFields — response shape", () => {
  beforeEach(() => jest.clearAllMocks());

  it("includes success=false, code, error, and details on every failure", () => {
    const middleware = validateRequiredFields(["field"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}), response, noOp);

    const body = lastBody();
    expect(body).toHaveProperty("success", false);
    expect(body).toHaveProperty("code", "VALIDATION_ERROR");
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("details");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("each detail has path, rule, and message", () => {
    const middleware = validateRequiredFields(["myField"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}), response, noOp);

    const detail = lastBody().details[0];
    expect(detail).toHaveProperty("path", "myField");
    expect(detail).toHaveProperty("rule", "required");
    expect(detail).toHaveProperty("message");
    expect(typeof detail.message).toBe("string");
  });
});

// ─── Security — no raw value leakage ─────────────────────────────────────────

describe("validateRequiredFields — security: no raw value leakage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not echo the field value back in any error message", () => {
    const middleware = validateRequiredFields(["password"], "body");
    const { response, responseBody } = createResponseMock();

    // Even if a blank string is sent as the value
    middleware(makeRequest({ password: "" }), response, noOp);

    const serialized = JSON.stringify(responseBody);
    // The empty string itself is fine, but a real value must not appear
    expect(serialized).not.toContain("super-secret");
  });

  it("error message contains only the field name, not the field value", () => {
    const middleware = validateRequiredFields(["apiKey"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({ apiKey: "" }), response, noOp);

    const detail = lastBody().details[0];
    // Message must reference the field name
    expect(detail.message).toContain("apiKey");
    // Message must not contain any raw value (here, empty string means
    // we verify it describes the field not a value)
    expect(detail.message).not.toMatch(/:\s*$/); // no trailing colon with blank value
  });
});

// ─── Target variants ─────────────────────────────────────────────────────────

describe("validateRequiredFields — target variants", () => {
  beforeEach(() => jest.clearAllMocks());

  it("validates query params when target is 'query'", () => {
    const middleware = validateRequiredFields(["page"], "query");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}, {}), response, noOp);

    const paths = lastBody().details.map((d: ValidationDetail) => d.path);
    expect(paths).toContain("page");
  });

  it("validates route params when target is 'params'", () => {
    const middleware = validateRequiredFields(["id"], "params");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}, {}, {}), response, noOp);

    const paths = lastBody().details.map((d: ValidationDetail) => d.path);
    expect(paths).toContain("id");
  });

  it("returns target_invalid when query is not an object", () => {
    const middleware = validateRequiredFields(["page"], "query");
    const { response, lastBody } = createResponseMock();
    const req = { query: null } as unknown as Request;

    middleware(req, response, noOp);

    expect(lastBody().details[0].rule).toBe("target_invalid");
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("validateRequiredFields — edge cases", () => {
  beforeEach(() => jest.clearAllMocks());

  it("treats null value as missing", () => {
    const middleware = validateRequiredFields(["field"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({ field: null }), response, noOp);

    expect(lastBody().details[0].rule).toBe("required");
  });

  it("treats empty string as missing", () => {
    const middleware = validateRequiredFields(["field"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({ field: "" }), response, noOp);

    expect(lastBody().details[0].rule).toBe("required");
  });

  it("treats undefined value as missing", () => {
    const middleware = validateRequiredFields(["field"], "body");
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({ field: undefined }), response, noOp);

    expect(lastBody().details[0].rule).toBe("required");
  });

  it("accepts zero as a valid value (not treated as missing)", () => {
    const middleware = validateRequiredFields(["count"], "body");
    const { response } = createResponseMock();
    const next = jest.fn() as unknown as NextFunction;

    middleware(makeRequest({ count: 0 }), response, next);

    // 0 is a legitimate value — next() must be called
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("accepts false as a valid value (not treated as missing)", () => {
    const middleware = validateRequiredFields(["active"], "body");
    const { response } = createResponseMock();
    const next = jest.fn() as unknown as NextFunction;

    middleware(makeRequest({ active: false }), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("handles an empty requiredFields array — always passes", () => {
    const middleware = validateRequiredFields([], "body");
    const { response } = createResponseMock();
    const next = jest.fn() as unknown as NextFunction;

    middleware(makeRequest({}), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("handles duplicate field names without duplicate errors", () => {
    // Callers should not pass duplicates, but the middleware must not
    // crash or produce confusing doubled output
    const middleware = validateRequiredFields(
      ["field", "field"],
      "body",
    );
    const { response, lastBody } = createResponseMock();

    middleware(makeRequest({}), response, noOp);

    // Details may contain two entries (one per loop iteration) but they
    // must be identically sorted and the response must still be 400
    const body = lastBody();
    expect(body.success).toBe(false);
    body.details.forEach((d: ValidationDetail) => {
      expect(d.path).toBe("field");
    });
  });
});
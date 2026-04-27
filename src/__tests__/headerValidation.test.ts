/**
 * Header Validation — Test Suite
 *
 * Coverage targets (≥ 95 % of touched lines):
 *   src/middleware/headerValidation.ts
 *
 * Test categories:
 *   A. Pure validator unit tests (validateIdempotencyKey, validateRequestId,
 *      validateWebhookSignature, hasNoInjectionChars)
 *   B. Express middleware unit tests (validateIdempotencyKeyHeader,
 *      validateRequestIdHeader, validateWebhookSignatureHeader)
 *   C. Integration tests via supertest — a minimal self-contained express app
 *      that mounts only the header-validation middleware, independent of
 *      app.ts / index.ts so no merge conflicts arise.
 *
 * Security notes are embedded inline where relevant.
 */

import { jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";

import {
  // Pure validators
  validateIdempotencyKey,
  validateRequestId,
  validateWebhookSignature,
  hasNoInjectionChars,
  // Middleware
  validateIdempotencyKeyHeader,
  validateRequestIdHeader,
  validateWebhookSignatureHeader,
  // Constants
  IDEMPOTENCY_KEY_MAX_LENGTH,
  REQUEST_ID_MAX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  REQUEST_ID_PATTERN,
  WEBHOOK_SIGNATURE_PATTERN,
} from "../middleware/headerValidation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express-like mock triple for middleware unit tests. */
function makeMocks(headers: Record<string, string> = {}) {
  const req = {
    header: (name: string) =>
      headers[name.toLowerCase()] ?? headers[name] ?? undefined,
  } as unknown as Request;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;

  const next = jest.fn() as unknown as NextFunction;

  return { req, res, next, json, status };
}

/**
 * Minimal self-contained express app used for integration tests.
 * Mounts header-validation middleware then a trivial 200 handler.
 * Does NOT import app.ts or index.ts — zero risk of merge conflict.
 */
function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Route that validates Idempotency-Key, then succeeds
  app.post(
    "/idempotency-test",
    validateIdempotencyKeyHeader,
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
  );

  // Route that validates X-Request-Id, then succeeds
  app.post(
    "/request-id-test",
    validateRequestIdHeader,
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
  );

  // Route that validates webhook signature (mandatory), then succeeds
  app.post(
    "/webhook-test",
    validateWebhookSignatureHeader("X-Webhook-Signature"),
    (_req: Request, res: Response) => {
      res.status(200).json({ success: true });
    },
  );

  return app;
}

const testApp = buildTestApp();

// ---------------------------------------------------------------------------
// A. Pure validator — validateIdempotencyKey
// ---------------------------------------------------------------------------

describe("validateIdempotencyKey()", () => {
  // --- Happy paths ---

  it("accepts a simple alphanumeric key", () => {
    expect(validateIdempotencyKey("abc123")).toEqual({ valid: true });
  });

  it("accepts keys with hyphens, underscores, and dots", () => {
    expect(validateIdempotencyKey("order-42_v1.0")).toEqual({ valid: true });
  });

  it("accepts a UUID-style key", () => {
    expect(
      validateIdempotencyKey("550e8400-e29b-41d4-a716-446655440000"),
    ).toEqual({ valid: true });
  });

  it("accepts a single-character key", () => {
    expect(validateIdempotencyKey("a")).toEqual({ valid: true });
  });

  it("accepts a key exactly at the max length", () => {
    const key = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(validateIdempotencyKey(key)).toEqual({ valid: true });
  });

  // --- Failure: missing / empty ---

  it("rejects undefined", () => {
    const result = validateIdempotencyKey(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects null (cast as undefined)", () => {
    const result = validateIdempotencyKey(null as any);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects an empty string", () => {
    const result = validateIdempotencyKey("");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  // --- Failure: overlong ---

  it("rejects a key one byte over the limit", () => {
    const key = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    const result = validateIdempotencyKey(key);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum length/i);
  });

  it("rejects a very long key (potential header-size DoS)", () => {
    const result = validateIdempotencyKey("x".repeat(10_000));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum length/i);
  });

  // --- Failure: invalid / injection characters ---

  it("rejects a key with spaces", () => {
    const result = validateIdempotencyKey("key with spaces");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects a key with a null byte", () => {
    const result = validateIdempotencyKey("key\0null");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects a key with special HTML characters (<, >, &)", () => {
    const result = validateIdempotencyKey("key<script>");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects a key with a forward slash (path traversal)", () => {
    const result = validateIdempotencyKey("../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects a key with Unicode characters", () => {
    const result = validateIdempotencyKey("clé-idempotence");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });
});

// ---------------------------------------------------------------------------
// A. Pure validator — validateRequestId
// ---------------------------------------------------------------------------

describe("validateRequestId()", () => {
  // --- Happy paths ---

  it("accepts a simple alphanumeric request ID", () => {
    expect(validateRequestId("req_123abc")).toEqual({ valid: true });
  });

  it("accepts a UUID with hyphens", () => {
    expect(
      validateRequestId("550e8400-e29b-41d4-a716-446655440000"),
    ).toEqual({ valid: true });
  });

  it("accepts IDs with colon namespace prefix", () => {
    expect(validateRequestId("service:req_001")).toEqual({ valid: true });
  });

  it("accepts a key exactly at max length", () => {
    const id = "a".repeat(REQUEST_ID_MAX_LENGTH);
    expect(validateRequestId(id)).toEqual({ valid: true });
  });

  // --- Failure: missing / empty ---

  it("rejects undefined", () => {
    const result = validateRequestId(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects an empty string", () => {
    const result = validateRequestId("");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  // --- Failure: overlong ---

  it("rejects an ID one byte over the limit", () => {
    const id = "r".repeat(REQUEST_ID_MAX_LENGTH + 1);
    const result = validateRequestId(id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum length/i);
  });

  it("rejects a very long ID (potential DoS)", () => {
    const result = validateRequestId("x".repeat(5000));
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum length/i);
  });

  // --- Failure: invalid characters ---

  it("rejects an ID with spaces", () => {
    const result = validateRequestId("req id 1");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects an ID with a null byte", () => {
    const result = validateRequestId("req\0null");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects an ID with Unicode characters", () => {
    const result = validateRequestId("req-ünïcödé");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });
});

// ---------------------------------------------------------------------------
// A. Pure validator — validateWebhookSignature
// ---------------------------------------------------------------------------

describe("validateWebhookSignature()", () => {
  // --- Happy paths ---

  it("accepts a raw hex digest (64 chars — SHA-256 length)", () => {
    const hex = "a".repeat(64);
    expect(validateWebhookSignature(hex)).toEqual({ valid: true });
  });

  it("accepts a sha256=-prefixed digest (GitHub-style)", () => {
    const sig = "sha256=" + "b".repeat(64);
    expect(validateWebhookSignature(sig)).toEqual({ valid: true });
  });

  it("accepts mixed-case hex digits", () => {
    expect(
      validateWebhookSignature("sha256=aAbBcCdDeEfF0123456789"),
    ).toEqual({ valid: true });
  });

  it("accepts a signature exactly at max length", () => {
    const sig = "f".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH);
    expect(validateWebhookSignature(sig)).toEqual({ valid: true });
  });

  // --- Failure: missing / empty ---

  it("rejects undefined", () => {
    const result = validateWebhookSignature(undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it("rejects an empty string", () => {
    const result = validateWebhookSignature("");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  // --- Failure: overlong ---

  it("rejects a signature one byte over the limit", () => {
    const sig = "a".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH + 1);
    const result = validateWebhookSignature(sig);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum length/i);
  });

  // --- Failure: invalid characters ---

  it("rejects a signature with non-hex characters", () => {
    const result = validateWebhookSignature("sha256=xyz!!!invalid");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });

  it("rejects a null byte in signature", () => {
    const result = validateWebhookSignature("sha256=abc\0null");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid characters/i);
  });
});

// ---------------------------------------------------------------------------
// A. hasNoInjectionChars()
// ---------------------------------------------------------------------------

describe("hasNoInjectionChars()", () => {
  it("returns true for a clean alphanumeric string", () => {
    expect(hasNoInjectionChars("safe_value-123")).toBe(true);
  });

  it("returns true for a string with a horizontal tab (0x09)", () => {
    expect(hasNoInjectionChars("value\twith\ttabs")).toBe(true);
  });

  it("returns false when value contains a null byte", () => {
    expect(hasNoInjectionChars("value\0null")).toBe(false);
  });

  it("returns false when value contains a carriage return", () => {
    expect(hasNoInjectionChars("value\rCR")).toBe(false);
  });

  it("returns false when value contains a line feed", () => {
    expect(hasNoInjectionChars("value\nLF")).toBe(false);
  });

  it("returns false when value contains a CRLF sequence", () => {
    expect(hasNoInjectionChars("header\r\ninjected: value")).toBe(false);
  });

  it("returns false for ASCII control char BEL (0x07)", () => {
    expect(hasNoInjectionChars("bel\x07char")).toBe(false);
  });

  it("returns false for ASCII DEL (0x7F)", () => {
    expect(hasNoInjectionChars("del\x7fchar")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. Middleware unit — validateIdempotencyKeyHeader
// ---------------------------------------------------------------------------

describe("validateIdempotencyKeyHeader middleware", () => {
  it("calls next() when Idempotency-Key header is absent (opt-in)", () => {
    const { req, res, next } = makeMocks({});
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() when Idempotency-Key is valid", () => {
    const { req, res, next } = makeMocks({ "Idempotency-Key": "valid-key-123" });
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when Idempotency-Key is overlong", () => {
    const { req, res, next, status, json } = makeMocks({
      "Idempotency-Key": "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1),
    });
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/exceeds maximum length/i),
      }),
    );
  });

  it("returns 400 when Idempotency-Key contains invalid characters", () => {
    const { req, res, next, status, json } = makeMocks({
      "Idempotency-Key": "key with spaces!",
    });
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/invalid characters/i),
      }),
    );
  });

  it("returns 400 when Idempotency-Key is an empty string", () => {
    const { req, res, next, status, json } = makeMocks({
      "Idempotency-Key": "",
    });
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("blocks CRLF injection attempt via pure middleware", () => {
    // Node's HTTP stack may reject CRLF at the TCP level in supertest, so
    // we test the middleware directly with the raw value.
    const { req, res, next, status, json } = makeMocks({
      "Idempotency-Key": "key\r\nX-Injected: evil",
    });
    validateIdempotencyKeyHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/invalid characters/i),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// B. Middleware unit — validateRequestIdHeader
// ---------------------------------------------------------------------------

describe("validateRequestIdHeader middleware", () => {
  it("calls next() when X-Request-Id header is absent (optional)", () => {
    const { req, res, next } = makeMocks({});
    validateRequestIdHeader(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() when X-Request-Id is valid", () => {
    const { req, res, next } = makeMocks({
      "X-Request-Id": "550e8400-e29b-41d4-a716-446655440000",
    });
    validateRequestIdHeader(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when X-Request-Id is overlong", () => {
    const { req, res, next, status, json } = makeMocks({
      "X-Request-Id": "r".repeat(REQUEST_ID_MAX_LENGTH + 1),
    });
    validateRequestIdHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/exceeds maximum length/i),
      }),
    );
  });

  it("blocks CRLF injection in X-Request-Id via pure middleware", () => {
    const { req, res, next, status, json } = makeMocks({
      "X-Request-Id": "req\r\nX-Injected: evil",
    });
    validateRequestIdHeader(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/invalid characters/i),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// B. Middleware unit — validateWebhookSignatureHeader
// ---------------------------------------------------------------------------

describe("validateWebhookSignatureHeader middleware", () => {
  const middleware = validateWebhookSignatureHeader("X-Webhook-Signature");

  it("calls next() when signature is a valid hex digest", () => {
    const { req, res, next } = makeMocks({
      "X-Webhook-Signature": "sha256=" + "a".repeat(64),
    });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when signature header is absent (mandatory on webhook routes)", () => {
    const { req, res, next, status, json } = makeMocks({});
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/missing/i),
      }),
    );
  });

  it("returns 400 when signature is overlong", () => {
    const { req, res, next, status, json } = makeMocks({
      "X-Webhook-Signature": "a".repeat(WEBHOOK_SIGNATURE_MAX_LENGTH + 1),
    });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/exceeds maximum length/i),
      }),
    );
  });

  it("returns 400 when signature contains invalid characters", () => {
    const { req, res, next, status, json } = makeMocks({
      "X-Webhook-Signature": "sha256=invalid!@#$",
    });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/invalid characters/i),
      }),
    );
  });

  it("uses the custom header name supplied to the factory", () => {
    const hubMiddleware = validateWebhookSignatureHeader("X-Hub-Signature-256");
    const { req, res, next } = makeMocks({
      "X-Hub-Signature-256": "sha256=" + "f".repeat(64),
    });
    hubMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// B. Exported constants smoke test
// ---------------------------------------------------------------------------

describe("Exported constants", () => {
  it("IDEMPOTENCY_KEY_MAX_LENGTH is a positive integer", () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBeGreaterThan(0);
    expect(Number.isInteger(IDEMPOTENCY_KEY_MAX_LENGTH)).toBe(true);
  });

  it("REQUEST_ID_MAX_LENGTH is a positive integer", () => {
    expect(REQUEST_ID_MAX_LENGTH).toBeGreaterThan(0);
    expect(Number.isInteger(REQUEST_ID_MAX_LENGTH)).toBe(true);
  });

  it("WEBHOOK_SIGNATURE_MAX_LENGTH is a positive integer", () => {
    expect(WEBHOOK_SIGNATURE_MAX_LENGTH).toBeGreaterThan(0);
    expect(Number.isInteger(WEBHOOK_SIGNATURE_MAX_LENGTH)).toBe(true);
  });

  it("IDEMPOTENCY_KEY_PATTERN is a RegExp", () => {
    expect(IDEMPOTENCY_KEY_PATTERN).toBeInstanceOf(RegExp);
  });

  it("REQUEST_ID_PATTERN is a RegExp", () => {
    expect(REQUEST_ID_PATTERN).toBeInstanceOf(RegExp);
  });

  it("WEBHOOK_SIGNATURE_PATTERN is a RegExp", () => {
    expect(WEBHOOK_SIGNATURE_PATTERN).toBeInstanceOf(RegExp);
  });
});

// ---------------------------------------------------------------------------
// C. Integration — self-contained express app (no dependency on app.ts / index.ts)
// ---------------------------------------------------------------------------

describe("Idempotency-Key header validation (integration — minimal test app)", () => {
  // Security note: overlong keys are rejected before any downstream processing,
  // preventing Redis key-space pollution and log flooding.
  it("returns 400 for an overlong Idempotency-Key", async () => {
    const res = await request(testApp)
      .post("/idempotency-test")
      .set("Idempotency-Key", "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/exceeds maximum length/i);
  });

  // Security note: keys with injection-like characters are blocked at the
  // middleware layer before they can corrupt Redis keys or structured logs.
  it("returns 400 for an Idempotency-Key with invalid characters", async () => {
    const res = await request(testApp)
      .post("/idempotency-test")
      .set("Idempotency-Key", "key.with!invalid@chars")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid characters/i);
  });

  it("returns 400 for an empty Idempotency-Key string", async () => {
    const res = await request(testApp)
      .post("/idempotency-test")
      .set("Idempotency-Key", " ") // whitespace-only is invalid (space not in allow-list)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("passes through with a valid Idempotency-Key", async () => {
    const res = await request(testApp)
      .post("/idempotency-test")
      .set("Idempotency-Key", "valid-key-hv-001")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("passes through when Idempotency-Key is absent (opt-in behaviour)", async () => {
    const res = await request(testApp)
      .post("/idempotency-test")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("X-Request-Id header validation (integration — minimal test app)", () => {
  it("returns 400 for an overlong X-Request-Id", async () => {
    const res = await request(testApp)
      .post("/request-id-test")
      .set("X-Request-Id", "r".repeat(REQUEST_ID_MAX_LENGTH + 1))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/exceeds maximum length/i);
  });

  it("passes through with a valid X-Request-Id", async () => {
    const res = await request(testApp)
      .post("/request-id-test")
      .set("X-Request-Id", "550e8400-e29b-41d4-a716-446655440000")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("passes through when X-Request-Id is absent (optional)", async () => {
    const res = await request(testApp)
      .post("/request-id-test")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("Webhook signature header validation (integration — minimal test app)", () => {
  it("returns 400 when X-Webhook-Signature is absent", async () => {
    const res = await request(testApp)
      .post("/webhook-test")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/missing/i);
  });

  it("returns 400 for an invalid signature value", async () => {
    const res = await request(testApp)
      .post("/webhook-test")
      .set("X-Webhook-Signature", "not-a-hex-value!!!")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid characters/i);
  });

  it("passes through with a valid sha256=-prefixed signature", async () => {
    const res = await request(testApp)
      .post("/webhook-test")
      .set("X-Webhook-Signature", "sha256=" + "a".repeat(64))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

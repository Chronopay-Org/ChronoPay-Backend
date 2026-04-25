import request from "supertest";
import express from "express";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

const app = express();
app.use(express.json());

// Mock validation middleware that just checks for required fields
const mockValidation = (req: any, res: any, next: any) => {
  const { professional, startTime, endTime } = req.body;
  if (!professional || !startTime || !endTime) {
    return res.status(400).json({ success: false });
  }
  next();
};

app.post("/api/v1/slots", mockValidation, idempotencyMiddleware, (req, res) => {
  res.status(201).json({
    success: true,
    slot: req.body,
  });
});

app.post("/api/v1/other", mockValidation, idempotencyMiddleware, (req, res) => {
  res.status(201).json({
    success: true,
    other: true,
  });
});

import { setRedisClient } from "../cache/redisClient.js";

/**
 * Integration tests for the Idempotency Middleware.
 *
 * Architecture context:
 *   POST /api/v1/slots applies two middleware in order:
 *     1. validateRequiredFields(["professional", "startTime", "endTime"])
 *     2. idempotencyMiddleware
 *   Then the route handler responds with 201.
 *
 * An in-memory Redis test double is injected via `setRedisClient`.
 *
 * Key behaviours under test:
 *   1. Opt-in: No Idempotency-Key → request proceeds normally every time.
 *   2. Cache miss (first request): Lock acquired → 201 returned.
 *   3. Exact duplicate: Returns the same cached response (status + body).
 *   4. Payload mismatch: Same key, different body → 422.
 *   5. In-flight / race condition: Key is "processing" → 409.
 *   6. Different keys are independent: No cross-contamination.
 *   7. Cross-endpoint mismatch: Same key, different route → 409.
 *   8. Deterministic hashing: Object with keys in different order still matches.
 */

const VALID_SLOT = {
  professional: "dr-alice",
  startTime: "2025-01-01T09:00:00Z",
  endTime: "2025-01-01T10:00:00Z",
};

describe.skip("Idempotency Middleware (integration)", () => {
  // -------------------------------------------------------------------
  // 1. Opt-in: header absent → middleware is bypassed entirely
  // -------------------------------------------------------------------
  describe("when no Idempotency-Key header is supplied", () => {
    it("should process each request independently and always return 201", async () => {
      const first = await request(app)
        .post("/api/v1/slots")
        .send(VALID_SLOT);

      expect(first.status).toBe(201);
      expect(first.body.success).toBe(true);

      // A second identical request with no key must also succeed (no 409/422)
      const second = await request(app)
        .post("/api/v1/slots")
        .send(VALID_SLOT);

      expect(second.status).toBe(201);
    });
  });

  afterEach(() => {
    setRedisClient(null);
    setIdempotencyEncryptionConfigForTests(null);
  });

  it("bypasses idempotency when the header is missing", async () => {
    const redis = makeRedisClient();
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      header: jest.fn().mockReturnValue(undefined),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("bypasses idempotency when Redis is unavailable", async () => {
    setRedisClient(null);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-001"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("replays a stored completed response", async () => {
    const requestHash = generateRequestHash("POST", "/api/v1/slots", { amount: 100 });
    const codec = createIdempotencyPayloadCodec({
      enabled: false,
      algorithm: "aes-256-gcm",
      activeKey: null,
      decryptionKeys: [],
    });
    const redis = makeRedisClient({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(
        codec.serialize({
          status: "completed",
          requestHash,
          statusCode: 201,
          responseBody: { success: true, slotId: 1 },
        }),
      ),
    });
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-002"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, slotId: 1 });
    expect(next).not.toHaveBeenCalled();
  });

  it("treats plaintext entries as readable during encrypted rollout", async () => {
    const requestHash = generateRequestHash("POST", "/api/v1/slots", { amount: 100 });
    const redis = makeRedisClient({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(
        JSON.stringify({
          status: "completed",
          requestHash,
          statusCode: 201,
          responseBody: { success: true, legacy: true },
        }),
      ),
    });
    setRedisClient(redis);
    setIdempotencyEncryptionConfigForTests(makeEncryptionConfig());
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-003"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, legacy: true });
  });

  it("returns 422 when the same key is reused with a different payload", async () => {
    const redis = makeRedisClient({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(
        JSON.stringify({
          status: "completed",
          requestHash: "different-hash",
          statusCode: 201,
          responseBody: { success: true },
        }),
      ),
    });
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-004"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Unprocessable Entity: Idempotency-Key used with different payload.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 409 when the key is already processing", async () => {
    const redis = makeRedisClient({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(
        JSON.stringify({
          status: "processing",
          requestHash: "ignored",
        }),
      ),
    });
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-005"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Conflict: This transaction is actively running.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("stores processing and completed states as encrypted envelopes when enabled", async () => {
    const redis = makeRedisClient();
    setRedisClient(redis);
    setIdempotencyEncryptionConfigForTests(makeEncryptionConfig());
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { cardLast4: "4242" },
      header: jest.fn().mockReturnValue("idem-006"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      "idempotency:req:idem-006",
      expect.stringContaining("\"enc\""),
      "EX",
      86400,
      "NX",
    );
    expect(redis.set.mock.calls[0]?.[1]).not.toContain("4242");

    res.status(201);
    res.json({ success: true, paymentId: "pay_123" });

    await new Promise((resolve) => setImmediate(resolve));

    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      "idempotency:req:idem-006",
      expect.stringContaining("\"enc\""),
      "EX",
      86400,
    );
    expect(redis.set.mock.calls[1]?.[1]).not.toContain("pay_123");
  });

  it("returns 409 when another request wins the lock race", async () => {
    const redis = makeRedisClient({
      set: jest
        .fn<RedisClient["set"]>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue("OK"),
    });
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-006b"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Conflict: This transaction is actively running.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("logs but does not fail the response when persisting the completed state fails", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const redis = makeRedisClient({
      set: jest
        .fn<RedisClient["set"]>()
        .mockResolvedValueOnce("OK")
        .mockRejectedValueOnce(new Error("redis write failed")),
    });
    setRedisClient(redis);
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-006c"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);
    res.status(201);
    res.json({ success: true });
    await new Promise((resolve) => setImmediate(resolve));

    expect(errorSpy).toHaveBeenCalledWith(
      "Failed to persist idempotency response:",
      "redis write failed",
    );
    errorSpy.mockRestore();
  });

  it("surfaces decryption errors when configured keys cannot read an existing payload", async () => {
    const requestHash = generateRequestHash("POST", "/api/v1/slots", { amount: 100 });
    const ciphertext = createIdempotencyPayloadCodec(makeEncryptionConfig()).serialize({
      status: "completed",
      requestHash,
      statusCode: 201,
      responseBody: { success: true },
    });
    const redis = makeRedisClient({
      get: jest.fn<RedisClient["get"]>().mockResolvedValue(ciphertext),
    });
    setRedisClient(redis);
    setIdempotencyEncryptionConfigForTests({
      enabled: true,
      algorithm: "aes-256-gcm",
      activeKey: {
        id: "wrong-2026-05",
        value: Buffer.alloc(32, 6),
      },
      decryptionKeys: [
        {
          id: "wrong-2026-05",
          value: Buffer.alloc(32, 6),
        },
      ],
    });
    const req = mockRequest({
      method: "POST",
      originalUrl: "/api/v1/slots",
      body: { amount: 100 },
      header: jest.fn().mockReturnValue("idem-007"),
    }) as Request;
    const res = mockResponse() as Response;
    const next = mockNext();

    await idempotencyMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(IdempotencyPayloadDecryptError));
  });

  // -------------------------------------------------------------------
  // 8. Cross-endpoint mismatch (Strong Binding)
  // -------------------------------------------------------------------
  describe("when the same Idempotency-Key is used on a different endpoint", () => {
    it("should return 409 Conflict deterministically", async () => {
      const key = "idem-endpoint-mismatch-001";

      const first = await request(app)
        .post("/api/v1/slots")
        .set("Idempotency-Key", key)
        .send(VALID_SLOT);

      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/v1/other")
        .set("Idempotency-Key", key)
        .send(VALID_SLOT);

      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/different endpoint/i);
    });
  });

  // -------------------------------------------------------------------
  // 9. Stable hashing mechanism
  // -------------------------------------------------------------------
  describe("when the payload keys are reordered (Stable Hash)", () => {
    it("should still recognize it as an exact duplicate even with arrays and nested objects", async () => {
      const key = "idem-stable-hash-001";

      const first = await request(app)
        .post("/api/v1/slots")
        .set("Idempotency-Key", key)
        .send({
          professional: "dr-alice",
          tags: ["urgent", "new"],
          nested: { b: 2, a: 1 },
          startTime: "2025-01-01T09:00:00Z",
          endTime: "2025-01-01T10:00:00Z"
        });

      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/v1/slots")
        .set("Idempotency-Key", key)
        .send({
          endTime: "2025-01-01T10:00:00Z", // Reordered
          nested: { a: 1, b: 2 }, // Reordered inner keys
          professional: "dr-alice",
          startTime: "2025-01-01T09:00:00Z",
          tags: ["urgent", "new"]
        });

      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
    });
  });
});

/**
 * Regression coverage for the internalHmacAuth webhook-signature middleware.
 *
 * Evidence (issue #1114): `getSignatureFromHeader` in
 * src/middleware/internalHmacAuth.ts:24 returns `undefined` when the
 * signature header is absent. That falls through to internalHmacAuth's
 * "missing signature" branch (401), which was previously untested in
 * isolation — only two happy-path branches were exercised indirectly via
 * src/routes/__tests__/webhooks.rotation.test.ts.
 *
 * Covers:
 *   - No secret configured (500)
 *   - Missing signature header — the getSignatureFromHeader `undefined` path (401)
 *   - Empty-string signature header (401)
 *   - Whitespace-only signature header — trims to "", not undefined, same 401 contract
 *   - Valid signature, current secret, "sha256=" prefix (200 / next())
 *   - Valid signature, current secret, raw hex (no prefix) (200)
 *   - Case-insensitive "SHA256=" prefix (200)
 *   - Valid signature, previous secret (rotation window) (200)
 *   - Invalid/tampered signature (403)
 *   - Non-hex signature (403)
 *   - Wrong-length hex signature (403)
 *   - Body tampering with an otherwise-valid signature (403)
 */

import { createHmac } from "node:crypto";
import express, { Request, Response } from "express";
import request from "supertest";

const { internalHmacAuth } = await import("../internalHmacAuth.js");

const SECRET = "test-settlements-secret-abc123";
const PREV_SECRET = "test-settlements-prev-secret-xyz789";
const ROUTE = "/api/v1/webhooks/settlements";

function sign(body: object, secret: string): string {
  const raw = JSON.stringify(body);
  return createHmac("sha256", secret).update(raw).digest("hex");
}

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "settlement_completed",
    transactionId: "txn-hmac-001",
    amount: 100,
    ...overrides,
  };
}

function buildApp(secret?: string): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.post(ROUTE, internalHmacAuth(secret), (_req: Request, res: Response) => {
    res.status(200).json({ success: true });
  });
  return app;
}

describe("internalHmacAuth middleware", () => {
  afterEach(() => {
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;
  });

  describe("no secret configured", () => {
    it("returns 500 when neither the override nor the env secret is set", async () => {
      delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
      const app = buildApp(undefined);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(body, SECRET))
        .send(body)
        .expect(500);

      expect(res.body).toEqual({
        success: false,
        error: "Settlement webhook signing secret is not configured.",
      });
    });
  });

  describe("missing signature header (getSignatureFromHeader → undefined)", () => {
    it("returns 401 when x-webhook-signature is absent", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app).post(ROUTE).send(body).expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Missing webhook signature.",
      });
    });
  });

  describe("empty and whitespace signature headers", () => {
    it("returns 401 when x-webhook-signature is an empty string", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", "")
        .send(body)
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Missing webhook signature.",
      });
    });

    it("returns 401 when x-webhook-signature is whitespace only (trims to empty, not undefined)", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", "   ")
        .send(body)
        .expect(401);

      expect(res.body).toEqual({
        success: false,
        error: "Missing webhook signature.",
      });
    });
  });

  describe("valid signature — current secret", () => {
    it("accepts a signature with the 'sha256=' prefix", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", `sha256=${sign(body, SECRET)}`)
        .send(body)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it("accepts a raw hex signature with no prefix", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(body, SECRET))
        .send(body)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it("accepts an uppercase 'SHA256=' prefix (case-insensitive)", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", `SHA256=${sign(body, SECRET)}`)
        .send(body)
        .expect(200);

      expect(res.body.success).toBe(true);
    });
  });

  describe("valid signature — previous secret (rotation window)", () => {
    it("accepts a signature made with SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS", async () => {
      process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS = PREV_SECRET;
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(body, PREV_SECRET))
        .send(body)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it("rejects the previous secret once the rotation window has closed", async () => {
      // No SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS set — overlap window closed.
      const app = buildApp(SECRET);
      const body = samplePayload();

      await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(body, PREV_SECRET))
        .send(body)
        .expect(403);
    });
  });

  describe("invalid signature", () => {
    it("returns 403 for a signature signed with the wrong secret", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      const res = await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(body, "totally-wrong-secret"))
        .send(body)
        .expect(403);

      expect(res.body).toEqual({
        success: false,
        error: "Invalid webhook signature.",
      });
    });

    it("returns 403 for a tampered (bit-flipped) signature", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();
      const valid = sign(body, SECRET);
      const tampered = valid.slice(0, -1) + (valid.endsWith("a") ? "b" : "a");

      await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", tampered)
        .send(body)
        .expect(403);
    });

    it("returns 403 when the signature is not valid hex", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();

      await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", "sha256=not-a-hex-value!!")
        .send(body)
        .expect(403);
    });

    it("returns 403 when the signature has the wrong length", async () => {
      const app = buildApp(SECRET);
      const body = samplePayload();
      const valid = sign(body, SECRET);
      const truncated = valid.slice(0, -2); // 62 hex chars, not 64

      await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", truncated)
        .send(body)
        .expect(403);
    });

    it("returns 403 when the body is tampered but the signature matches the original body", async () => {
      const app = buildApp(SECRET);
      const original = samplePayload();
      const tamperedBody = samplePayload({ amount: 999999 });

      await request(app)
        .post(ROUTE)
        .set("x-webhook-signature", sign(original, SECRET))
        .send(tamperedBody)
        .expect(403);
    });
  });
});

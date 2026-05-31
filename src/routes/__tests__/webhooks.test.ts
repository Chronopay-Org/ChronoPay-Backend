import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { registerWebhookRoutes, _resetProcessedTransactions } from "../webhooks.js";

const SECRET = "test-webhook-secret";

function buildApp() {
  const app = express();

  // Capture raw body for HMAC verification (mirrors production setup)
  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  registerWebhookRoutes(app, { signingSecret: SECRET });
  return app;
}

function sign(body: object): string {
  const raw = JSON.stringify(body);
  return createHmac("sha256", SECRET).update(raw).digest("hex");
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "settlement_completed",
    transactionId: "txn-001",
    amount: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

async function post(app: ReturnType<typeof buildApp>, body: object, sig?: string) {
  const signature = sig ?? sign(body);
  return request(app)
    .post("/api/v1/webhooks/settlements")
    .set("x-webhook-signature", signature)
    .send(body);
}

describe("POST /api/v1/webhooks/settlements", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    _resetProcessedTransactions();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe("HMAC authentication", () => {
    it("returns 500 when signing secret is not configured", async () => {
      const unsecuredApp = express();
      unsecuredApp.use(express.json());
      registerWebhookRoutes(unsecuredApp, {});

      const res = await request(unsecuredApp)
        .post("/api/v1/webhooks/settlements")
        .send(validPayload());

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it("returns 401 when signature header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/webhooks/settlements")
        .send(validPayload());

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("returns 403 when signature is invalid", async () => {
      const res = await post(app, validPayload(), "a".repeat(64));
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("accepts sha256= prefixed signature", async () => {
      const body = validPayload();
      const sig = `sha256=${sign(body)}`;
      const res = await request(app)
        .post("/api/v1/webhooks/settlements")
        .set("x-webhook-signature", sig)
        .send(body);

      expect(res.status).toBe(200);
    });
  });

  // ── Required fields ───────────────────────────────────────────────────────

  describe("required field validation", () => {
    it.each(["eventType", "transactionId", "amount", "timestamp"])(
      "returns 400 when %s is missing",
      async (field) => {
        const body = validPayload();
        delete (body as any)[field];
        const res = await post(app, body);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
      },
    );
  });

  // ── eventType ─────────────────────────────────────────────────────────────

  describe("eventType validation", () => {
    it.each(["settlement_completed", "settlement_initiated", "settlement_failed"])(
      "accepts %s",
      async (eventType) => {
        const res = await post(app, validPayload({ eventType }));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      },
    );

    it("returns 400 for an unknown eventType", async () => {
      const res = await post(app, validPayload({ eventType: "payment_received" }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for an empty string eventType", async () => {
      const res = await post(app, validPayload({ eventType: "" }));
      // Empty string fails required-field check
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ── amount ────────────────────────────────────────────────────────────────

  describe("amount validation", () => {
    it("returns 400 for zero amount", async () => {
      const res = await post(app, validPayload({ amount: 0 }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for negative amount", async () => {
      const res = await post(app, validPayload({ amount: -50 }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for string amount", async () => {
      const res = await post(app, validPayload({ amount: "100" }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("accepts a positive decimal amount", async () => {
      const res = await post(app, validPayload({ amount: 0.01 }));
      expect(res.status).toBe(200);
    });
  });

  // ── timestamp ─────────────────────────────────────────────────────────────

  describe("timestamp validation", () => {
    it("returns 400 for zero timestamp", async () => {
      const res = await post(app, validPayload({ timestamp: 0 }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for negative timestamp", async () => {
      const res = await post(app, validPayload({ timestamp: -1 }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 400 for non-numeric timestamp (string)", async () => {
      const res = await post(app, validPayload({ timestamp: "now" }));
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 403 for a stale timestamp (>5 min old)", async () => {
      const stale = Date.now() - 6 * 60 * 1000;
      const res = await post(app, validPayload({ timestamp: stale }));
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("returns 403 for a future timestamp (>1 min ahead)", async () => {
      const future = Date.now() + 2 * 60 * 1000;
      const res = await post(app, validPayload({ timestamp: future }));
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  describe("successful processing", () => {
    it("returns 200 with echoed body for a valid settlement_completed event", async () => {
      const body = validPayload({ eventType: "settlement_completed" });
      const res = await post(app, body);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        received: expect.objectContaining({
          eventType: "settlement_completed",
          transactionId: "txn-001",
          amount: 100,
        }),
      });
    });

    it("returns the same 200 response for a duplicate transactionId (idempotency)", async () => {
      const body = validPayload();
      await post(app, body);

      // Second request with same transactionId but different amount
      const body2 = validPayload({ amount: 999 });
      const res = await post(app, body2);

      expect(res.status).toBe(200);
      // Should return the original cached response, not process again
      expect(res.body.received.amount).toBe(100);
    });
  });

  // ── Extra fields ──────────────────────────────────────────────────────────

  describe("extra fields", () => {
    it("accepts payloads with extra fields without error", async () => {
      const res = await post(app, validPayload({ extra: "ignored" }));
      expect(res.status).toBe(200);
    });
  });
});

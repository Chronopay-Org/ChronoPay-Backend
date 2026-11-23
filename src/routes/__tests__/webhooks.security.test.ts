/**
 * Security regression tests for #1307.
 *
 * The default-exported webhook router is mounted at /api/v1 in createApp().
 * It used to register POST /settlements (no HMAC) alongside the admin
 * idempotency endpoints (no admin auth), which exposed:
 *   - POST /api/v1/settlements            → forged settlement records
 *   - GET  /api/v1/admin/idempotency/…    → read idempotency records
 *   - POST /api/v1/admin/idempotency/sweep → wipe them
 *
 * These tests drive the full createApp() wiring because the exposure only
 * exists at the app-mount level (registerWebhookRoutes + app.use("/api/v1",
 * webhookRoutes)).
 *
 * Also covers the transactionId / x-tenant-id validation added for the
 * idempotency-key issue: malformed ids must be rejected with 400 before any
 * store access, so they can never collapse onto a shared "undefined" key.
 */
import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { createHmac } from "node:crypto";
import request from "supertest";
import { createApp } from "../../app.js";
import { _settlements } from "../../services/settlementReconciler.js";
import { WebhookIdempotencyStore } from "../../services/webhookIdempotencyStore.js";

const SETTLEMENT_SECRET = "test-settlements-hmac-secret-1307";
const ADMIN_TOKEN = "test-admin-token-1307";
const ADMIN_TOKEN_HEADER = "x-chronopay-admin-token";

const originalSettlementSecret = process.env.SETTLEMENTS_WEBHOOK_SECRET;
const originalAdminToken = process.env.CHRONOPAY_ADMIN_TOKEN;

const app = createApp({ enableDocs: false, enableContentNegotiation: false });

beforeAll(() => {
  process.env.SETTLEMENTS_WEBHOOK_SECRET = SETTLEMENT_SECRET;
  process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
});

afterAll(() => {
  if (originalSettlementSecret === undefined) {
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
  } else {
    process.env.SETTLEMENTS_WEBHOOK_SECRET = originalSettlementSecret;
  }
  if (originalAdminToken === undefined) {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
  } else {
    process.env.CHRONOPAY_ADMIN_TOKEN = originalAdminToken;
  }
});

beforeEach(() => {
  _settlements.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function settlementPayload(transactionId: unknown = "txn-1307-unsigned") {
  return {
    eventType: "settlement_completed",
    transactionId,
    amount: 100,
    // Fresh timestamp: the /api/v1 settlement handler rejects stale payloads.
    timestamp: Date.now(),
  };
}

function signedRequest(body: unknown) {
  const signature = createHmac("sha256", SETTLEMENT_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
  return request(app)
    .post("/api/v1/webhooks/settlements")
    .set("x-webhook-signature", signature)
    .send(body as object);
}

describe("security regression #1307: unauthenticated settlement & idempotency routes", () => {
  describe("POST /api/v1/settlements (unauthenticated duplicate of the settlement webhook)", () => {
    it("is rejected without a signature and does not modify _settlements", async () => {
      const res = await request(app).post("/api/v1/settlements").send(settlementPayload());

      expect([401, 403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(_settlements.has("txn-1307-unsigned")).toBe(false);
    });

    it("is rejected even when a forged signature header is supplied", async () => {
      const forged = createHmac("sha256", "forged-secret").update("{}").digest("hex");
      const res = await request(app)
        .post("/api/v1/settlements")
        .set("x-webhook-signature", forged)
        .send(settlementPayload());

      expect([401, 403, 404]).toContain(res.status);
      expect(_settlements.has("txn-1307-unsigned")).toBe(false);
    });
  });

  describe("admin idempotency endpoints", () => {
    it("GET /api/v1/admin/idempotency/:tenantId/:key returns 401 without the admin token", async () => {
      const res = await request(app).get("/api/v1/admin/idempotency/tenant-1307/key-1307");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("POST /api/v1/admin/idempotency/sweep returns 401 without the admin token", async () => {
      const res = await request(app).post("/api/v1/admin/idempotency/sweep");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("returns 403 when the admin token is wrong", async () => {
      const res = await request(app)
        .get("/api/v1/admin/idempotency/tenant-1307/key-1307")
        .set(ADMIN_TOKEN_HEADER, "not-the-admin-token");

      expect(res.status).toBe(403);
    });

    it("GET returns the inspected record with a valid admin token", async () => {
      jest.spyOn(WebhookIdempotencyStore, "inspect").mockResolvedValue({
        tenant_id: "tenant-1307",
        idempotency_key: "key-1307",
        response_body: { success: true },
      });

      const res = await request(app)
        .get("/api/v1/admin/idempotency/tenant-1307/key-1307")
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.idempotency_key).toBe("key-1307");
    });

    it("sweep runs with a valid admin token", async () => {
      const res = await request(app)
        .post("/api/v1/admin/idempotency/sweep")
        .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.deletedCount).toBe("number");
    });
  });

  describe("POST /api/v1/webhooks/settlements (the protected provider path)", () => {
    it("keeps working with a valid HMAC signature", async () => {
      const body = settlementPayload("txn-1307-signed");
      const res = await signedRequest(body);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(_settlements.get("txn-1307-signed")).toMatchObject({
        status: "pending_finality",
        amount: 100,
      });
    });

    it("rejects a missing transactionId with 400 and writes nothing", async () => {
      const body = settlementPayload(undefined);
      delete (body as Record<string, unknown>).transactionId;
      const idemSpy = jest.spyOn(WebhookIdempotencyStore, "saveKey");

      const res = await signedRequest(body);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).toMatch(/transactionId/);
      expect(idemSpy).not.toHaveBeenCalled();
      expect(_settlements.size).toBe(0);
    });

    it("rejects a numeric-object transactionId with 400 and writes nothing", async () => {
      const idemSpy = jest.spyOn(WebhookIdempotencyStore, "saveKey");

      const res = await signedRequest(settlementPayload({ id: 1307 }));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).toMatch(/transactionId/);
      expect(idemSpy).not.toHaveBeenCalled();
      expect(_settlements.size).toBe(0);
    });

    it("rejects an oversize transactionId (>128 chars) with 400 and writes nothing", async () => {
      const idemSpy = jest.spyOn(WebhookIdempotencyStore, "saveKey");

      const res = await signedRequest(settlementPayload("a".repeat(129)));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).toMatch(/transactionId/);
      expect(idemSpy).not.toHaveBeenCalled();
      expect(_settlements.size).toBe(0);
    });

    it("rejects an x-tenant-id that exceeds the length bound with 400", async () => {
      const body = settlementPayload("txn-1307-tenant");
      const signature = createHmac("sha256", SETTLEMENT_SECRET)
        .update(JSON.stringify(body))
        .digest("hex");

      const res = await request(app)
        .post("/api/v1/webhooks/settlements")
        .set("x-webhook-signature", signature)
        .set("x-tenant-id", "t".repeat(129))
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).toMatch(/x-tenant-id/);
      expect(_settlements.has("txn-1307-tenant")).toBe(false);
    });
  });
});

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import type { KycProvider } from "../../services/kycProvider.js";

const SECRET = "test-kyc-webhook-secret";

// 1. Mock the pg pool module
const mockQuery = jest.fn() as any;
jest.unstable_mockModule("../../db/pool.js", () => {
  return {
    query: mockQuery,
    default: { query: mockQuery },
  };
});

// 2. Import modules AFTER mocking
const { registerWebhookRoutes } = await import("../webhooks.js");

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

  registerWebhookRoutes(app, { kycSigningSecret: SECRET });
  return app;
}

function sign(body: object): string {
  const raw = JSON.stringify(body);
  return "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
}

describe("POST /api/v1/webhooks/kyc", () => {
  let app: ReturnType<typeof buildApp>;
  const supplierId = "550e8400-e29b-41d4-a716-446655440000"; // Valid UUID

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  it("advances supplier KYC status from pending to verified", async () => {
    // Mock getSupplierKyc returning a pending supplier
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: supplierId,
          email: "supplier@example.com",
          kyc_status: "pending",
          kyc_ref: null,
        },
      ],
    });

    // Mock updateKycStatus returning success
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [],
    });

    const payload = {
      supplierId,
      kycRef: "ref-123",
      status: "verified",
    };

    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      supplierId,
      kycStatus: "verified",
      kycRef: "ref-123",
    });

    // Verify DB calls
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain(
      "SELECT id, email, kyc_status, kyc_ref, region FROM users",
    );
    expect(mockQuery.mock.calls[1][0]).toContain("UPDATE users SET kyc_status = $1, kyc_ref = $2");
    expect(mockQuery.mock.calls[1][1]).toEqual(["verified", "ref-123", supplierId]);
  });

  describe("Rollback behaviors", () => {
    const rollbacks = [
      { from: "verified", to: "pending", expected: "pending" },
      { from: "verified", to: "rejected", expected: "rejected" },
      { from: "verified", to: "under_review", expected: "under_review" },
    ];

    for (const { from, to, expected } of rollbacks) {
      it(`rolls back supplier status from ${from} to ${expected}`, async () => {
        mockQuery.mockResolvedValueOnce({
          rowCount: 1,
          rows: [
            {
              id: supplierId,
              email: "supplier@example.com",
              kyc_status: from,
              kyc_ref: "ref-old",
            },
          ],
        });

        mockQuery.mockResolvedValueOnce({
          rowCount: 1,
          rows: [],
        });

        const payload = {
          supplierId,
          kycRef: "ref-new",
          status: to,
        };

        const res = await request(app)
          .post("/api/v1/webhooks/kyc")
          .set("x-webhook-signature", sign(payload))
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.kycStatus).toBe(expected);

        expect(mockQuery.mock.calls[1][1]).toEqual([expected, "ref-new", supplierId]);
      });
    }
  });

  it("returns 403 Forbidden for an invalid signature", async () => {
    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", "invalid-signature")
      .send(payload);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid webhook signature.");
  });

  it("returns 400 Bad Request for missing required fields", async () => {
    const payload = { supplierId, status: "verified" }; // missing kycRef
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("kycRef");
  });

  it("returns 400 Bad Request for an unknown/invalid status", async () => {
    const payload = { supplierId, kycRef: "ref-123", status: "invalid_status" };
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Invalid status: invalid_status");
  });

  it("returns 404 Not Found if supplier does not exist", async () => {
    // Mock getSupplierKyc returning no rows
    mockQuery.mockResolvedValueOnce({
      rowCount: 0,
      rows: [],
    });

    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("not found");
  });

  it("returns 404 if the supplier disappears between read and update", async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: supplierId,
          email: "supplier@example.com",
          kyc_status: "pending",
          kyc_ref: null,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({
      rowCount: 0, // UPDATE matched zero rows
      rows: [],
    });

    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });

  it("returns 401 Unauthorized when the signature header is missing", async () => {
    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const res = await request(app).post("/api/v1/webhooks/kyc").send(payload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Missing webhook signature.");
  });

  it("returns 400 Bad Request for an over-long kycRef", async () => {
    const payload = {
      supplierId,
      kycRef: "x".repeat(256),
      status: "verified",
    };
    const res = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("kycRef");
  });

  it("delivers the same event twice idempotently (retry-safe)", async () => {
    // First delivery: pending -> verified
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: supplierId,
          email: "supplier@example.com",
          kyc_status: "pending",
          kyc_ref: null,
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // Retry delivery: already verified
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          id: supplierId,
          email: "supplier@example.com",
          kyc_status: "verified",
          kyc_ref: "ref-123",
        },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const first = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);
    const retry = await request(app)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      success: true,
      supplierId,
      kycStatus: "verified",
      kycRef: "ref-123",
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    // Both deliveries re-apply the status update; bootstrap grant must not
    // double-fire (guarded by the pending -> verified transition in
    // KycService.processWebhook — asserted directly in kycService tests).
    const updateCalls = mockQuery.mock.calls.filter((call: any) =>
      String(call[0]).includes("UPDATE users SET kyc_status"),
    );
    expect(updateCalls).toHaveLength(2);
  });

  it("handles concurrent duplicate deliveries without error", async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, email, kyc_status")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: supplierId,
              email: "supplier@example.com",
              kyc_status: "pending",
              kyc_ref: null,
            },
          ],
        };
      }
      if (sql.includes("UPDATE users SET kyc_status")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const payload = { supplierId, kycRef: "ref-123", status: "verified" };
    const [a, b] = await Promise.all([
      request(app)
        .post("/api/v1/webhooks/kyc")
        .set("x-webhook-signature", sign(payload))
        .send(payload),
      request(app)
        .post("/api/v1/webhooks/kyc")
        .set("x-webhook-signature", sign(payload))
        .send(payload),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.kycStatus).toBe("verified");
    expect(b.body.kycStatus).toBe("verified");
  });

  it("uses a pluggable kyc provider when provided", async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, email, kyc_status")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: supplierId,
              email: "supplier@example.com",
              kyc_status: "pending",
              kyc_ref: null,
            },
          ],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const parseWebhook = jest.fn<KycProvider["parseWebhook"]>().mockImplementation(() => ({
      supplierId,
      kycRef: "custom-ref",
      status: "verified" as const,
    }));

    const customApp = express();
    customApp.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    registerWebhookRoutes(customApp, {
      kycSigningSecret: SECRET,
      kycProvider: { name: "CustomProvider", parseWebhook },
    });

    const payload = { supplierId, kycRef: "ignored", status: "verified" };
    const res = await request(customApp)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(payload))
      .send(payload);

    expect(parseWebhook).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      supplierId,
      kycStatus: "verified",
      kycRef: "custom-ref",
    });
  });

  it("returns 500 when the KYC signing secret is not configured", async () => {
    const previous = process.env.KYC_WEBHOOK_SECRET;
    delete process.env.KYC_WEBHOOK_SECRET;
    try {
      const unsecuredApp = express();
      unsecuredApp.use(
        express.json({
          verify: (req: any, _res, buf) => {
            req.rawBody = buf;
          },
        }),
      );
      registerWebhookRoutes(unsecuredApp, {});

      const payload = { supplierId, kycRef: "ref-123", status: "verified" };
      // Even a well-formed signature cannot verify without a configured secret.
      const res = await request(unsecuredApp)
        .post("/api/v1/webhooks/kyc")
        .set("x-webhook-signature", sign(payload))
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("signing secret is not configured");
    } finally {
      if (previous === undefined) delete process.env.KYC_WEBHOOK_SECRET;
      else process.env.KYC_WEBHOOK_SECRET = previous;
    }
  });

  it("co-registers settlements and kyc webhooks without interference", async () => {
    const combinedApp = express();
    combinedApp.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      }),
    );
    registerWebhookRoutes(combinedApp, {
      signingSecret: SECRET,
      kycSigningSecret: SECRET,
    });

    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, email, kyc_status")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: supplierId,
              email: "supplier@example.com",
              kyc_status: "pending",
              kyc_ref: null,
            },
          ],
        };
      }
      if (sql.includes("UPDATE users SET kyc_status")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const kycPayload = { supplierId, kycRef: "ref-123", status: "verified" };
    const kycRes = await request(combinedApp)
      .post("/api/v1/webhooks/kyc")
      .set("x-webhook-signature", sign(kycPayload))
      .send(kycPayload);
    expect(kycRes.status).toBe(200);
    expect(kycRes.body.kycStatus).toBe("verified");

    // Settlements route is still registered and its HMAC boundary still
    // enforced independently of the kyc secret handling.
    const settleRes = await request(combinedApp)
      .post("/api/v1/webhooks/settlements")
      .set("x-webhook-signature", "deadbeef")
      .send({
        eventType: "settlement_completed",
        transactionId: "txn-1",
        amount: 100,
        timestamp: Date.now(),
      });
    expect(settleRes.status).toBe(403);
    expect(settleRes.body.error).toContain("Invalid webhook signature.");
  });
});

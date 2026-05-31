import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

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
    expect(mockQuery.mock.calls[0][0]).toContain("SELECT id, email, kyc_status, kyc_ref FROM users");
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
});

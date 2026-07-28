import request from "supertest";
import express from "express";
import adminRouter, { pendingReplays } from "../routes/admin.js";
import { _settlements } from "../services/settlementReconciler.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

const app = buildApp();

describe("Dual-Admin Payout Replay Endpoints", () => {
  beforeEach(() => {
    _settlements.clear();
    pendingReplays.clear();
  });

  const mockTransactionId = "tx-12345";

  function seedFailedSettlement(transactionId = mockTransactionId) {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "PAYOUT",
      amount: 100,
      timestamp: Date.now(),
      status: "failed",
      confirmations: 0,
      attempts: 5,
    });
  }

  function seedPendingFinalitySettlement(transactionId = mockTransactionId) {
    _settlements.set(transactionId, {
      transactionId,
      eventType: "PAYOUT",
      amount: 100,
      timestamp: Date.now(),
      status: "pending_finality",
      confirmations: 0,
      attempts: 0,
    });
  }

  describe("POST /api/v1/admin/payouts/:transactionId/replay", () => {
    it("should successfully initiate a replay for a failed settlement", async () => {
      seedFailedSettlement();
      
      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay`)
        .set("x-chronopay-user-id", "admin-1")
        .set("x-chronopay-role", "admin")
        .send({ reason: "Network issue during payout" });
        
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.pendingRequest).toBeDefined();
      expect(res.body.pendingRequest.initiatorId).toBe("admin-1");
      expect(pendingReplays.has(mockTransactionId)).toBe(true);
    });

    it("should reject if no reason is provided", async () => {
      seedFailedSettlement();
      
      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay`)
        .set("x-chronopay-user-id", "admin-1")
        .set("x-chronopay-role", "admin")
        .send({ reason: "" });
        
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("valid reason");
    });

    it("should reject if settlement is not in a failed state", async () => {
      seedPendingFinalitySettlement();
      
      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay`)
        .set("x-chronopay-user-id", "admin-1")
        .set("x-chronopay-role", "admin")
        .send({ reason: "I want to replay" });
        
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Only failed settlements can be replayed");
    });

    it("should return 401 if not authenticated", async () => {
      seedFailedSettlement();
      
      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay`)
        .send({ reason: "Replay" });
        
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/v1/admin/payouts/:transactionId/replay/approve", () => {
    it("should successfully approve a replay by a different admin", async () => {
      seedFailedSettlement();
      pendingReplays.set(mockTransactionId, {
        transactionId: mockTransactionId,
        initiatorId: "admin-1",
        reason: "Valid reason",
        expiresAt: Date.now() + 10000,
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay/approve`)
        .set("x-chronopay-user-id", "admin-2")
        .set("x-chronopay-role", "admin")
        .send();
        
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settlement.status).toBe("pending_finality");
      expect(res.body.settlement.attempts).toBe(0);
      expect(pendingReplays.has(mockTransactionId)).toBe(false);
    });

    it("should reject approval by the same admin (initiator)", async () => {
      seedFailedSettlement();
      pendingReplays.set(mockTransactionId, {
        transactionId: mockTransactionId,
        initiatorId: "admin-1",
        reason: "Valid reason",
        expiresAt: Date.now() + 10000,
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay/approve`)
        .set("x-chronopay-user-id", "admin-1")
        .set("x-chronopay-role", "admin")
        .send();
        
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("different admin");
      
      // Settlement should remain failed
      const settlement = _settlements.get(mockTransactionId);
      expect(settlement?.status).toBe("failed");
    });

    it("should reject approval if TTL has expired", async () => {
      seedFailedSettlement();
      pendingReplays.set(mockTransactionId, {
        transactionId: mockTransactionId,
        initiatorId: "admin-1",
        reason: "Valid reason",
        expiresAt: Date.now() - 1000, // Expired 1 second ago
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay/approve`)
        .set("x-chronopay-user-id", "admin-2")
        .set("x-chronopay-role", "admin")
        .send();
        
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("expired");
      expect(pendingReplays.has(mockTransactionId)).toBe(false);
    });

    it("should reject if admin role is revoked (invalid role passed)", async () => {
      seedFailedSettlement();
      pendingReplays.set(mockTransactionId, {
        transactionId: mockTransactionId,
        initiatorId: "admin-1",
        reason: "Valid reason",
        expiresAt: Date.now() + 10000,
      });

      const res = await request(app)
        .post(`/api/v1/admin/payouts/${mockTransactionId}/replay/approve`)
        .set("x-chronopay-user-id", "admin-2")
        .set("x-chronopay-role", "customer") // non-admin role
        .send();
        
      expect(res.status).toBe(403);
    });
  });
});

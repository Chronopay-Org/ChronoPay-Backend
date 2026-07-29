import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { defaultSupplierCancellationOverrideStore } from "../../services/supplierCancellationOverrideStore.js";

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRouter);

const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

describe("Admin Cancellation Override CRUD API", () => {
  beforeEach(() => {
    process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
    defaultSupplierCancellationOverrideStore.reset();
  });

  afterEach(() => {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
    defaultSupplierCancellationOverrideStore.reset();
  });

  describe("GET /api/v1/admin/cancellation-overrides", () => {
    it("returns 200 with empty list initially", async () => {
      const res = await request(app)
        .get("/api/v1/admin/cancellation-overrides")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.overrides).toEqual([]);
    });

    it("returns 401 without admin token", async () => {
      const res = await request(app)
        .get("/api/v1/admin/cancellation-overrides");

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/admin/cancellation-overrides/:supplierId", () => {
    it("returns 404 for non-existent override", async () => {
      const res = await request(app)
        .get("/api/v1/admin/cancellation-overrides/nonexistent")
        .set(adminHeaders);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No cancellation override found");
    });

    it("returns 200 with override when it exists", async () => {
      await defaultSupplierCancellationOverrideStore.setOverride(
        "supplier-1",
        { tiers: [{ minHoursUntilStart: 0, refundRatio: 0.5 }] },
        "admin-test",
      );

      const res = await request(app)
        .get("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.override.supplierId).toBe("supplier-1");
      expect(res.body.override.terms.tiers).toHaveLength(1);
    });
  });

  describe("PUT /api/v1/admin/cancellation-overrides/:supplierId", () => {
    it("creates a new override successfully", async () => {
      const res = await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({
          tiers: [
            { minHoursUntilStart: 48, refundRatio: 1.0, flatFee: 0 },
            { minHoursUntilStart: 24, maxHoursUntilStart: 48, refundRatio: 0.5, flatFee: 25 },
            { minHoursUntilStart: 0, maxHoursUntilStart: 24, refundRatio: 0.0, flatFee: 0 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.override.supplierId).toBe("supplier-1");
      expect(res.body.override.terms.tiers).toHaveLength(3);
    });

    it("creates with description and min/max refund bounds", async () => {
      const res = await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({
          tiers: [{ minHoursUntilStart: 0, refundRatio: 0.5 }],
          minRefundAmount: 100,
          maxRefundAmount: 5000,
          description: "Custom terms for supplier",
        });

      expect(res.status).toBe(200);
      expect(res.body.override.description).toBe("Custom terms for supplier");
      expect(res.body.override.terms.minRefundAmount).toBe(100);
      expect(res.body.override.terms.maxRefundAmount).toBe(5000);
    });

    it("updates an existing override", async () => {
      await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({ tiers: [{ minHoursUntilStart: 0, refundRatio: 0.5 }] });

      const res = await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({ tiers: [{ minHoursUntilStart: 0, refundRatio: 0.25 }] });

      expect(res.status).toBe(200);
      expect(res.body.override.terms.tiers[0].refundRatio).toBe(0.25);
    });

    it("returns 400 for empty tiers", async () => {
      const res = await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({ tiers: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("tiers must be a non-empty array");
    });

    it("returns 400 for invalid tier (negative refundRatio)", async () => {
      const res = await request(app)
        .put("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders)
        .send({ tiers: [{ minHoursUntilStart: 0, refundRatio: -0.1 }] });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/v1/admin/cancellation-overrides/:supplierId", () => {
    it("returns 404 for non-existent override", async () => {
      const res = await request(app)
        .delete("/api/v1/admin/cancellation-overrides/nonexistent")
        .set(adminHeaders);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("No cancellation override found");
    });

    it("deletes an existing override", async () => {
      await defaultSupplierCancellationOverrideStore.setOverride(
        "supplier-1",
        { tiers: [{ minHoursUntilStart: 0, refundRatio: 0.5 }] },
        "admin-test",
      );

      const res = await request(app)
        .delete("/api/v1/admin/cancellation-overrides/supplier-1")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe(true);

      expect(defaultSupplierCancellationOverrideStore.getOverride("supplier-1")).toBeUndefined();
    });
  });
});

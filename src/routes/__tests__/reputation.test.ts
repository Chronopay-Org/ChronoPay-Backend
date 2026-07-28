import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";
import express from "express";
import { createApp } from "../../app.js";
import reputationRouter from "../reputation.js";
import { reputationTransparencyService } from "../../services/reputationTransparencyService.js";

describe("Reputation Transparency API - GET /api/v1/suppliers/:supplierId/reputation/signals", () => {
  let app: any;

  beforeEach(() => {
    app = createApp();
  });

  it("should return 200 OK with aggregated signal projection for legitimate owner", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice")
      .set("x-tenant-id", "tenant-us-east");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();

    const data = res.body.data;
    expect(data.supplierId).toBe("supplier-101");
    expect(data.overallScore).toBeGreaterThan(0);
    expect(data.categoryBreakdown).toHaveLength(5);
    expect(data.privacyMetadata.buyerIdsRedacted).toBe(true);
    expect(data.privacyMetadata.smallCellSuppressionActive).toBe(true);
  });

  it("should return 401 Unauthorized when no authentication credentials are provided", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Authentication required");
  });

  it("should return 403 Forbidden when an unauthorized user attempts access (owner impersonation)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "unauthorized-hacker-id");

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("Access denied");
  });

  it("should return 404 Not Found for non-existent supplier ID", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/unknown-supplier-999/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("was not found");
  });

  it("should allow admin role access to view any supplier's reputation signals", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-chronopay-user-id", "admin-user")
      .set("x-chronopay-role", "admin");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.supplierId).toBe("supplier-101");
  });

  it("should reject cross-tenant access attempts with 403 Forbidden", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice")
      .set("x-tenant-id", "tenant-eu-west"); // Supplier 101 is on tenant-us-east

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it("should verify that raw buyer counterparty IDs are redacted from response payload", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice");

    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toMatch(/"buyer_?id"\s*:/i);
    expect(jsonStr).not.toMatch(/"counterparty_?id"\s*:/i);
  });

  it("should reflect small-cell count suppression for low-volume categories (< 5 evaluations)", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice");

    expect(res.status).toBe(200);
    const cancellationCategory = res.body.data.categoryBreakdown.find(
      (c: any) => c.category === "cancellation_rate"
    );

    expect(cancellationCategory).toBeDefined();
    expect(cancellationCategory.suppressed).toBe(true);
    expect(cancellationCategory.totalEvaluations).toBeNull();
    expect(cancellationCategory.categoryScore).toBeNull();
    expect(cancellationCategory.suppressionReason).toContain("Sample size < 5");
  });

  it("should authenticate using req.auth attached by auth middleware", async () => {
    const authApp = express();
    authApp.use((req: any, _res: any, next: any) => {
      req.auth = { userId: "owner-alice", role: "supplier_owner" };
      next();
    });
    authApp.use("/api/v1/suppliers", reputationRouter);

    const res = await request(authApp).get("/api/v1/suppliers/supplier-101/reputation/signals");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.supplierId).toBe("supplier-101");
  });

  it("should authenticate using req.user attached by JWT middleware", async () => {
    const jwtApp = express();
    jwtApp.use((req: any, _res: any, next: any) => {
      req.user = { sub: "owner-alice", role: "supplier_owner" };
      next();
    });
    jwtApp.use("/api/v1/suppliers", reputationRouter);

    const res = await request(jwtApp).get("/api/v1/suppliers/supplier-101/reputation/signals");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.supplierId).toBe("supplier-101");
  });

  it("should return 500 Internal Server Error when service throws an unexpected error", async () => {
    const spy = jest.spyOn(reputationTransparencyService, "getSignalProjection").mockImplementationOnce(() => {
      throw new Error("Unexpected database connection failure");
    });

    const res = await request(app)
      .get("/api/v1/suppliers/supplier-101/reputation/signals")
      .set("x-supplier-owner-id", "owner-alice");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Unexpected database connection failure");

    spy.mockRestore();
  });
});

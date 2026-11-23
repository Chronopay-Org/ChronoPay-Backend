/**
 * Tests for SOC2 Access Review Admin API endpoints
 *
 * Uses a minimal Express app with just the admin router to avoid
 * pre-existing issues with createApp().
 */

import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { accessReviewService } from "../../services/accessReviewService.js";

// Build a minimal app with just the admin router
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

const app = buildApp();

beforeEach(() => {
  accessReviewService.clear();
  // Set admin token globally so middleware can do proper auth checks
  process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
});

afterEach(() => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
});

describe("Admin Access Review API", () => {
  // ── Authentication ─────────────────────────────────────────────────────

  describe("authentication", () => {
    it("returns 401 without admin token header", async () => {
      const res = await request(app).post("/api/v1/admin/access-review/snapshots");
      expect(res.status).toBe(401);
    });

    it("returns 403 with invalid admin token", async () => {
      const res = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "wrong-token");
      expect(res.status).toBe(403);
    });

    it("all access-review endpoints require admin token", async () => {
      const endpoints: [string, string, Record<string, any> | undefined][] = [
        ["GET", "/api/v1/admin/access-review/snapshots", undefined],
        ["GET", "/api/v1/admin/access-review/snapshots/some-id", undefined],
        ["GET", "/api/v1/admin/access-review/snapshots/some-id/report", undefined],
        ["POST", "/api/v1/admin/access-review/snapshots/some-id/attestations", { reviewer: "test", outcome: "approved" }],
        ["GET", "/api/v1/admin/access-review/attestations", undefined],
        ["GET", "/api/v1/admin/access-review/gaps", undefined],
        ["GET", "/api/v1/admin/access-review/bundled-report", undefined],
      ];
      for (const [method, url, body] of endpoints) {
        const req = request(app)[method.toLowerCase() as "get"](url as string);
        if (body) req.send(body);
        const res = await req;
        expect(res.status).toBe(401);
      }
    });
  });

  // ── Full workflow integration tests ────────────────────────────────────

  describe("full workflow with admin token", () => {
    it("creates a snapshot and returns valid grant data", async () => {
      const res = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.snapshot.snapshotId).toBeTruthy();
      expect(res.body.snapshot.quarterLabel).toBeTruthy();
      expect(res.body.snapshot.grants.length).toBeGreaterThan(0);

      const roles = res.body.snapshot.grants.map((g: any) => g.role);
      expect(roles).toContain("admin");
      expect(roles).toContain("support");
    });

    it("creates a forced snapshot when force=true", async () => {
      const res1 = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const res2 = await request(app)
        .post("/api/v1/admin/access-review/snapshots?force=true")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res2.body.snapshot.snapshotId).not.toBe(res1.body.snapshot.snapshotId);
    });

    it("returns existing snapshot without force", async () => {
      const res1 = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const res2 = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res2.body.snapshot.snapshotId).toBe(res1.body.snapshot.snapshotId);
    });

    it("lists snapshots", async () => {
      await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const res = await request(app)
        .get("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBeGreaterThan(0);
    });

    it("returns snapshot summaries", async () => {
      await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const res = await request(app)
        .get("/api/v1/admin/access-review/snapshots?summaries=true")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.summaries).toBeDefined();
      expect(res.body.summaries.length).toBeGreaterThan(0);
    });

    it("gets a snapshot by ID", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .get(`/api/v1/admin/access-review/snapshots/${snapshotId}`)
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.snapshot.snapshotId).toBe(snapshotId);
    });

    it("returns 404 for non-existent snapshot", async () => {
      const res = await request(app)
        .get("/api/v1/admin/access-review/snapshots/non-existent")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(404);
    });

    it("generates JSON report for a snapshot", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .get(`/api/v1/admin/access-review/snapshots/${snapshotId}/report`)
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      const parsed = JSON.parse(res.text);
      expect(parsed.quarterLabel).toBeTruthy();
      expect(parsed.snapshot).toBeTruthy();
    });

    it("generates CSV report for a snapshot", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .get(`/api/v1/admin/access-review/snapshots/${snapshotId}/report?format=csv`)
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.text).toContain("# SOC2 Access Review Report");
    });

    it("creates an attestation for a snapshot", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "reviewer-alice", outcome: "approved" });

      expect(res.status).toBe(201);
      expect(res.body.attestation.outcome).toBe("approved");
      expect(res.body.attestation.reviewer).toBe("reviewer-alice");
    });

    it("returns 400 when attestation is missing reviewer", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ outcome: "approved" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reviewer is required");
    });

    it("returns 400 when attestation outcome is invalid", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      const res = await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "alice", outcome: "invalid" });

      expect(res.status).toBe(400);
    });

    it("returns 400 on duplicate attestation", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "alice", outcome: "approved" });

      const res = await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "alice", outcome: "approved" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("already exists");
    });

    it("lists attestations", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "alice", outcome: "approved" });

      const res = await request(app)
        .get("/api/v1/admin/access-review/attestations")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.total).toBeGreaterThan(0);
    });

    it("filters attestations by snapshotId", async () => {
      const createRes = await request(app)
        .post("/api/v1/admin/access-review/snapshots")
        .set("x-chronopay-admin-token", "test-admin-token");

      const snapshotId = createRes.body.snapshot.snapshotId;

      await request(app)
        .post(`/api/v1/admin/access-review/snapshots/${snapshotId}/attestations`)
        .set("x-chronopay-admin-token", "test-admin-token")
        .send({ reviewer: "alice", outcome: "approved" });

      const res = await request(app)
        .get(`/api/v1/admin/access-review/attestations?snapshotId=${snapshotId}`)
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });

    it("detects gaps", async () => {
      const res = await request(app)
        .get("/api/v1/admin/access-review/gaps")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.body.gaps).toBeDefined();
      expect(res.body.gaps).toHaveProperty("hasGap");
      expect(res.body.gaps).toHaveProperty("missingQuarters");
    });

    it("generates JSON bundled report", async () => {
      const res = await request(app)
        .get("/api/v1/admin/access-review/bundled-report")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("generates CSV bundled report", async () => {
      const res = await request(app)
        .get("/api/v1/admin/access-review/bundled-report?format=csv")
        .set("x-chronopay-admin-token", "test-admin-token");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
    });
  });
});

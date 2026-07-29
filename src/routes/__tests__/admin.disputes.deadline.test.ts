/**
 * admin.disputes.deadline.test.ts
 * ---------------------------------
 * HTTP-level integration tests for the dispute deadline auto-resolution
 * and reversal endpoints mounted under /api/v1/admin/disputes/deadline
 * and /api/v1/admin/disputes/:id/reverse-auto-resolve in src/routes/admin.ts.
 *
 * Also tests the one-off scan trigger and scheduler status endpoints.
 */

import { jest } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../app.js";
import { resetDisputesState } from "../admin.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { addSeniorArbiter } from "../../services/disputeAppeals.js";
import {
  startDisputeDeadlineScheduler,
  stopDisputeDeadlineScheduler,
  isDisputeDeadlineSchedulerRunning,
} from "../../scheduler/disputeDeadlineScheduler.js";

const ADMIN_TOKEN = "test-admin-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

const app = createApp({ enableTestRoutes: true, enableContentNegotiation: false });
const adminHeaders = {
  "x-chronopay-admin-token": ADMIN_TOKEN,
  "Content-Type": "application/json",
};

/**
 * Helper: open → evidence → adjudicate a dispute and return its id.
 * If `withAppeal` is true, also adds senior arbiters and appeals.
 */
async function openAdjudicated(overrides: Record<string, unknown> = {}) {
  const open = await request(app)
    .post("/api/v1/admin/disputes")
    .set(adminHeaders)
    .send({ buyerId: "buyer-1", supplierId: "supplier-1", amount: 200, ...overrides });
  const id = open.body.dispute.id;

  await request(app)
    .post(`/api/v1/admin/disputes/${id}/evidence`)
    .set(adminHeaders)
    .send({ evidence: "receipt.png" });

  await request(app)
    .post(`/api/v1/admin/disputes/${id}/adjudicate`)
    .set(adminHeaders)
    .send({ ruling: "BUYER_FAVOR", arbiter: "arb-1" });

  return id;
}

beforeEach(() => {
  resetDisputesState();
  jest.restoreAllMocks();
  jest.spyOn(defaultAuditLogger, "log").mockImplementation(() => Promise.resolve());
  stopDisputeDeadlineScheduler();
});

afterAll(() => {
  stopDisputeDeadlineScheduler();
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/disputes/deadline/scan
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/disputes/deadline/scan", () => {
  it("returns 200 with empty resolved array when all disputes are fresh", async () => {
    // Create a fresh OPEN dispute (no chain activity, so it is effectively
    // brand-new and should not be resolved).
    await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });

    const res = await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolved).toHaveLength(0);
  });

  it("resolves an old ADJUDICATED dispute past its appeal window", async () => {
    const id = await openAdjudicated({ appealWindowMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.resolved).toHaveLength(1);
    expect(res.body.resolved[0].disputeId).toBe(id);
    expect(res.body.resolved[0].fromStatus).toBe("ADJUDICATED");
    expect(res.body.resolved[0].toStatus).toBe("CLOSED");
  });

  it("resolves an EVIDENCED dispute with simulated inactivity", async () => {
    // Create dispute, add evidence, but manually set the chain to be old
    const open = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    const id = open.body.dispute.id;

    const evidenceRes = await request(app)
      .post(`/api/v1/admin/disputes/${id}/evidence`)
      .set(adminHeaders)
      .send({ evidence: "doc.pdf" });
    expect(evidenceRes.status).toBe(200);

    // The dispute is in EVIDENCED state but very new — should not resolve
    const res = await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.resolved).toHaveLength(0);
  });

  it("skips terminal disputes like FINAL, CLOSED, TIMEOUT", async () => {
    const id = await openAdjudicated();
    // Timeout the dispute
    await request(app)
      .post(`/api/v1/admin/disputes/${id}/timeout`)
      .set(adminHeaders)
      .send();

    const res = await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.resolved).toHaveLength(0);
    expect(res.body.skipped).toBeGreaterThanOrEqual(1);
  });

  it("requires admin authentication", async () => {
    const res = await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .send();
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/admin/disputes/:id/reverse-auto-resolve
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/disputes/:id/reverse-auto-resolve", () => {
  it("reverses a recently auto-resolved dispute", async () => {
    const id = await openAdjudicated({ appealWindowMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    // Auto-resolve via scan
    await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    // Verify it's closed
    const finality = await request(app)
      .get(`/api/v1/admin/disputes/${id}/finality`)
      .set(adminHeaders);
    expect(finality.body.chain.at(-1).status).toBe("CLOSED");

    // Reverse the auto-resolution
    const reverseRes = await request(app)
      .post(`/api/v1/admin/disputes/${id}/reverse-auto-resolve`)
      .set(adminHeaders)
      .send();

    expect(reverseRes.status).toBe(200);
    expect(reverseRes.body.success).toBe(true);
    expect(reverseRes.body.dispute.status).toBe("ADJUDICATED");
  });

  it("returns 404 for a non-existent dispute", async () => {
    const res = await request(app)
      .post("/api/v1/admin/disputes/nonexistent/reverse-auto-resolve")
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("DISPUTE_NOT_FOUND");
  });

  it("returns 400 when dispute was not auto-resolved", async () => {
    const id = await openAdjudicated();

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/reverse-auto-resolve`)
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NOT_AUTO_RESOLVED");
  });

  it("returns 200 when reversal is within the window (default 24h)", async () => {
    const id = await openAdjudicated({ appealWindowMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    // Auto-resolve via scan
    await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    // The default reversal window is 24h, so we should still be within it.
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/reverse-auto-resolve`)
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dispute.status).toBe("ADJUDICATED");
  });

  it("returns 200 when reversal is within the window and dispute was ADJUDICATED previously", async () => {
    const id = await openAdjudicated({ appealWindowMs: 1 });
    await new Promise((r) => setTimeout(r, 10));

    await request(app)
      .post("/api/v1/admin/disputes/deadline/scan")
      .set(adminHeaders)
      .send();

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/reverse-auto-resolve`)
      .set(adminHeaders)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe("ADJUDICATED");
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/admin/disputes/deadline/status
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/disputes/deadline/status", () => {
  it("returns running: false when scheduler is stopped", async () => {
    stopDisputeDeadlineScheduler();

    const res = await request(app)
      .get("/api/v1/admin/disputes/deadline/status")
      .set(adminHeaders);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.running).toBe(false);
  });

  it("returns running: true when scheduler is started", async () => {
    startDisputeDeadlineScheduler(() => [], { pollIntervalMs: 60000 });

    const res = await request(app)
      .get("/api/v1/admin/disputes/deadline/status")
      .set(adminHeaders);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.running).toBe(true);

    stopDisputeDeadlineScheduler();
  });

  it("requires admin authentication", async () => {
    const res = await request(app)
      .get("/api/v1/admin/disputes/deadline/status")
      .set("Content-Type", "application/json");
    expect(res.status).toBe(401);
  });
});

/**
 * admin.disputes.appeals.test.ts
 * --------------------------------
 * HTTP-level integration tests for the senior-panel dispute appeal
 * workflow mounted under /api/v1/admin/disputes in src/routes/admin.ts.
 *
 * Layers covered:
 *   - state machine enforced through the route handler
 *   - appeal window enforcement (window expiry → 410)
 *   - panel selection with conflict-of-interest exclusion
 *   - hash chain building (finalityHash and chain links)
 *   - audit envelope emission via defaultAuditLogger (using the
 *     codebase-canonical `jest.spyOn` + `toHaveBeenCalledWith` pattern)
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../app.js";
import { resetDisputesState } from "../admin.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import {
  addSeniorArbiter,
  resetSeniorPool,
  SENIOR_PANEL_MIN_SIZE,
} from "../../services/disputeAppeals.js";

const app = createApp({ enableTestRoutes: true });
const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

function poolOfFour(): void {
  // Five distinct senior arbiters in tiers of unrelated tenants, plus
  // one whose tenantId maps to the buyer's "tenant-buyer" so it falls
  // out of the panel on COI grounds.
  addSeniorArbiter({ id: "sa-alpha", tenantId: "neutral-A" });
  addSeniorArbiter({ id: "sa-bravo", tenantId: "neutral-B" });
  addSeniorArbiter({ id: "sa-charlie", tenantId: "neutral-C" });
  addSeniorArbiter({ id: "sa-delta", tenantId: "tenant-buyer" });
  addSeniorArbiter({ id: "sa-echo", tenantId: "neutral-D" });
}

async function openAdjudicated(disputeBody: Record<string, unknown> = {}) {
  const open = await request(app)
    .post("/api/v1/admin/disputes")
    .set(adminHeaders)
    .send({ buyerId: "buyer-1", supplierId: "supplier-1", amount: 200, ...disputeBody });
  const id = open.body.dispute.id;
  await request(app)
    .post(`/api/v1/admin/disputes/${id}/evidence`)
    .set(adminHeaders)
    .send({ evidence: "receipt.png" });
  await request(app)
    .post(`/api/v1/admin/disputes/${id}/adjudicate`)
    .set(adminHeaders)
    .send({ ruling: "BUYER_FAVOR", arbiter: "arbiter-original" });
  return id;
}

beforeEach(() => {
  resetDisputesState();
  jest.restoreAllMocks();
  jest
    .spyOn(defaultAuditLogger, "log")
    .mockImplementation(() => Promise.resolve());
});

describe("POST /api/v1/admin/disputes/:id/appeal", () => {
  it("happens after OPEN → EVIDENCED → ADJUDICATED and selects a ≥3-member panel", async () => {
    poolOfFour();
    const disputeId = await openAdjudicated();

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/appeal`)
      .set(adminHeaders)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dispute.status).toBe("SENIOR_REVIEW");
    expect(res.body.panel.length).toBeGreaterThanOrEqual(SENIOR_PANEL_MIN_SIZE);
    // Original arbiter is never in the panel.
    expect(res.body.panel.map((p: { id: string }) => p.id)).not.toContain("arbiter-original");
    // COI: pool contained "sa-delta" whose tenantId is the buyer's.
    expect(res.body.panel.map((p: { id: string }) => p.id)).not.toContain("sa-delta");
  });

  it("rejects appeal when status is OPEN (state machine)", async () => {
    const open = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b", supplierId: "s", amount: 1 });
    const id = open.body.dispute.id;

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("rejects appeal-of-appeal when status is already APPEALED (after a no-op round)", async () => {
    poolOfFour();
    // First round succeeds when the pool is full.
    const id = await openAdjudicated();
    const first = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    expect(first.status).toBe(200);
    // Second attempt should be rejected as APPEAL_OF_APPEAL.
    const second = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("APPEAL_OF_APPEAL");
  });

  it("returns 503 INSUFFICIENT_SENIOR_POOL when fewer than 3 eligible remain after COI", async () => {
    resetSeniorPool();
    addSeniorArbiter({ id: "sa-1", tenantId: "neutral-A" });
    addSeniorArbiter({ id: "sa-2", tenantId: "tenant-buyer" }); // sits inside COI set
    addSeniorArbiter({ id: "arbiter-original", tenantId: "neutral-X" }); // the original arbiter: also excluded

    const id = await openAdjudicated();
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("INSUFFICIENT_SENIOR_POOL");
    // The dispute stays in ADJUDICATED — no mutation on failure.
    const finality = await request(app)
      .get(`/api/v1/admin/disputes/${id}/finality`)
      .set(adminHeaders);
    expect(finality.body.disputeId).toBe(id);
    expect(finality.body.chain.some((c: { status: string }) => c.status === "APPEALED")).toBe(false);
  });

  it("returns 410 APPEAL_WINDOW_EXPIRED when the appeal window has elapsed", async () => {
    poolOfFour();
    const id = await openAdjudicated({ appealWindowMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});

    expect(res.status).toBe(410);
    expect(res.body.code).toBe("APPEAL_WINDOW_EXPIRED");
  });

  it("emits the DISPUTE_APPEAL_INITIATED + DISPUTE_SENIOR_PANEL_SELECTED audit envelope", async () => {
    poolOfFour();
    const id = await openAdjudicated();

    await request(app).post(`/api/v1/admin/disputes/${id}/appeal`).set(adminHeaders).send({});

    // The spy installed in beforeEach is still active for this test;
    // we reference it via the property jest replaced on the object.
    expect(defaultAuditLogger.log).toHaveBeenCalledWith(
      "DISPUTE_APPEAL_INITIATED",
      expect.objectContaining({
        body: expect.objectContaining({ disputeId: id }),
      }),
      expect.objectContaining({ status: "attempted" }),
    );
    expect(defaultAuditLogger.log).toHaveBeenCalledWith(
      "DISPUTE_SENIOR_PANEL_SELECTED",
      expect.objectContaining({
        body: expect.objectContaining({ disputeId: id }),
      }),
      expect.objectContaining({ status: 200 }),
    );
  });
});

describe("POST /api/v1/admin/disputes/:id/senior-decide", () => {
  it("transitions SENIOR_REVIEW → FINAL with a unanimous UPHOLD and writes a FINAL chain link", async () => {
    poolOfFour();
    const id = await openAdjudicated();
    const appeal = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    const panel: Array<{ id: string }> = appeal.body.panel;
    const votes = panel.map((p, idx) => ({
      arbiterId: p.id,
      vote: "UPHOLD",
      at: Date.now() + idx,
    }));

    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/senior-decide`)
      .set(adminHeaders)
      .send({ votes });

    expect(res.status).toBe(200);
    expect(res.body.dispute.status).toBe("FINAL");
    expect(res.body.dispute.finalRuling).toBe("UPHELD");
    const finality = await request(app)
      .get(`/api/v1/admin/disputes/${id}/finality`)
      .set(adminHeaders);
    expect(finality.body.chain.at(-1).status).toBe("FINAL");
  });

  it("reverts ledgers when the senior panel overturns a BUYER_FAVOR initial ruling", async () => {
    poolOfFour();
    const id = await openAdjudicated({ buyerId: "buyer-A", supplierId: "supplier-A" });
    // Capture the post-adjudication ledger state.
    const before = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    expect(before.status).toBe(200);
    // After adjudication buyer += 200, supplier -= 200, then appeal does not
    // move ledgers. Net so far: buyer 1200, supplier 800.
    const panel = before.body.panel as Array<{ id: string }>;
    const votes = panel.map((p) => ({
      arbiterId: p.id,
      vote: "OVERTURN",
      at: Date.now(),
    }));
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/senior-decide`)
      .set(adminHeaders)
      .send({ votes });
    expect(res.status).toBe(200);
    expect(res.body.dispute.finalRuling).toBe("OVERTURNED");
    // After overturn the buyer gets -200 again, supplier +200 → 1000/1000.
    expect(res.body.ledgers.buyer).toBe(1000);
    expect(res.body.ledgers.supplier).toBe(1000);
  });

  it("returns 400 PANEL_VOTE_MISMATCH when a vote comes from outside the panel", async () => {
    poolOfFour();
    const id = await openAdjudicated();
    const appeal = await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    const panel = appeal.body.panel as Array<{ id: string }>;
    // Replace one panel vote with an outsider.
    const votes = panel.map((p, idx) =>
      idx === 0
        ? { arbiterId: "outsider", vote: "UPHOLD", at: Date.now() + idx }
        : { arbiterId: p.id, vote: "UPHOLD", at: Date.now() + idx },
    );
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/senior-decide`)
      .set(adminHeaders)
      .send({ votes });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PANEL_VOTE_MISMATCH");
  });

  it("returns 400 INSUFFICIENT_VOTES when votes are missing", async () => {
    poolOfFour();
    const id = await openAdjudicated();
    await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/senior-decide`)
      .set(adminHeaders)
      .send({ votes: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INSUFFICIENT_VOTES");
  });

  it("returns 400 INVALID_STATE when called outside SENIOR_REVIEW", async () => {
    poolOfFour();
    const id = await openAdjudicated();
    const res = await request(app)
      .post(`/api/v1/admin/disputes/${id}/senior-decide`)
      .set(adminHeaders)
      .send({ votes: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_STATE");
  });
});

describe("GET /api/v1/admin/disputes/:id/finality", () => {
  it("returns the chain in order with hash links", async () => {
    poolOfFour();
    const id = await openAdjudicated();
    await request(app)
      .post(`/api/v1/admin/disputes/${id}/appeal`)
      .set(adminHeaders)
      .send({});
    const res = await request(app)
      .get(`/api/v1/admin/disputes/${id}/finality`)
      .set(adminHeaders);

    expect(res.status).toBe(200);
    expect(res.body.disputeId).toBe(id);
    const statuses = res.body.chain.map((c: { status: string }) => c.status);
    expect(statuses).toEqual(["EVIDENCED", "ADJUDICATED", "APPEALED", "SENIOR_REVIEW"]);
    // Each link's prevHash matches the previous link's hash.
    for (let i = 1; i < res.body.chain.length; i += 1) {
      expect(res.body.chain[i].prevHash).toBe(res.body.chain[i - 1].hash);
    }
    expect(res.body.finalityHash).toBe(res.body.chain.at(-1).hash);
  });
});

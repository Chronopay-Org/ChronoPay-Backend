/**
 * admin.noshow-appeal.test.ts
 * ---------------------------
 * HTTP-level integration tests for the no-show penalty appeal workflow
 * mounted under /api/v1/admin in src/routes/admin.ts.
 *
 * Covers:
 *   - Strike issuance (no-show penalty)
 *   - Strike appeal with evidence
 *   - Penalty pause on appeal filing
 *   - Arbitration queue escalation
 *   - Arbitration decision (uphold / overturn)
 *   - Edge cases (duplicate, non-existent, wrong state)
 */
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { strikeService } from "../../services/strikeService.js";

const ADMIN_TOKEN = "noshow-appeal-test-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

describe("No-Show Penalty Appeal & Arbitration Workflow", () => {
  let app: express.Application;

  beforeEach(() => {
    strikeService.resetState();
    app = makeApp();
  });

  // ─── Strike Issuance ──────────────────────────────────────────────────

  describe("POST /api/v1/admin/buyers/:buyerId/strikes", () => {
    it("issues a no-show penalty strike", async () => {
      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-ns-1/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show: buyer did not attend booking", intentId: "intent-001", slotId: "slot-001" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.strike.buyerId).toBe("buyer-ns-1");
      expect(res.body.strike.status).toBe("active");
      expect(res.body.strike.reason).toBe("No-show: buyer did not attend booking");
      expect(res.body.strike.intentId).toBe("intent-001");
      expect(res.body.strike.slotId).toBe("slot-001");
      expect(res.body.strike.id).toBeDefined();
    });
  });

  // ─── Appeal with Evidence ─────────────────────────────────────────────

  describe("POST /api/v1/admin/buyers/:buyerId/strikes/:strikeId/appeal", () => {
    it("appeals a no-show penalty with evidence and pauses enforcement", async () => {
      // First, issue a strike
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-appeal-evidence/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show penalty" });
      const strikeId = issueRes.body.strike.id;

      // Appeal with evidence
      const evidence = [
        "https://storage.example.com/evidence/gps-proof.png",
        "https://storage.example.com/evidence/chat-log.png",
      ];
      const appealRes = await request(app)
        .post(`/api/v1/admin/buyers/buyer-appeal-evidence/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "I was at the location but the app crashed", evidence });

      expect(appealRes.status).toBe(200);
      expect(appealRes.body.success).toBe(true);
      expect(appealRes.body.strike.status).toBe("appealed");
      expect(appealRes.body.strike.appealReason).toBe("I was at the location but the app crashed");
      expect(appealRes.body.strike.appealEvidence).toEqual(evidence);
      expect(appealRes.body.message).toContain("Penalty enforcement is paused");
    });

    it("appeals without evidence (optional field)", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-no-evidence/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show penalty" });
      const strikeId = issueRes.body.strike.id;

      const appealRes = await request(app)
        .post(`/api/v1/admin/buyers/buyer-no-evidence/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "I was present" });

      expect(appealRes.status).toBe(200);
      expect(appealRes.body.strike.status).toBe("appealed");
    });

    it("rejects duplicate appeal on an already appealed strike", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-dup-appeal/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      // First appeal succeeds
      await request(app)
        .post(`/api/v1/admin/buyers/buyer-dup-appeal/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "First appeal" });

      // Duplicate appeal is rejected
      const dupRes = await request(app)
        .post(`/api/v1/admin/buyers/buyer-dup-appeal/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Second appeal" });

      expect(dupRes.status).toBe(400);
      expect(dupRes.body.success).toBe(false);
    });

    it("rejects appeal of non-existent strike", async () => {
      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-x/strikes/non-existent-id/appeal")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });

      expect(res.status).toBe(404);
    });
  });

  // ─── Strike Retrieval ─────────────────────────────────────────────────

  describe("GET /api/v1/admin/buyers/:buyerId/strikes", () => {
    it("returns strikes and suspension status", async () => {
      await request(app)
        .post("/api/v1/admin/buyers/buyer-get/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Strike 1" });

      const res = await request(app)
        .get("/api/v1/admin/buyers/buyer-get/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.strikes.length).toBe(1);
      expect(res.body.activeStrikesCount).toBe(1);
    });
  });

  // ─── Arbitration Queue ───────────────────────────────────────────────

  describe("POST /api/v1/admin/strikes/:strikeId/escalate", () => {
    it("escalates an appealed strike to arbitration queue", async () => {
      // Issue and appeal a strike
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-arb/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show penalty" });
      const strikeId = issueRes.body.strike.id;

      await request(app)
        .post(`/api/v1/admin/buyers/buyer-arb/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal reason", evidence: ["evidence-1"] });

      // Escalate to arbitration
      const escalateRes = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(escalateRes.status).toBe(200);
      expect(escalateRes.body.success).toBe(true);
      expect(escalateRes.body.queueItem.status).toBe("pending");
      expect(escalateRes.body.queueItem.strikeId).toBe(strikeId);
      expect(escalateRes.body.queueItem.appealReason).toBe("Appeal reason");
      expect(escalateRes.body.queueItem.appealEvidence).toEqual(["evidence-1"]);

      // Verify it appears in the queue
      const queueRes = await request(app)
        .get("/api/v1/admin/strikes/arbitration/queue?status=pending")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(queueRes.body.queue.length).toBe(1);
    });

    it("rejects escalation of a non-appealed strike", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-no-appeal/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      // Try to escalate an active (not appealed) strike
      const res = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it("rejects duplicate escalation", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-dup-esc/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      await request(app)
        .post(`/api/v1/admin/buyers/buyer-dup-esc/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal" });

      // First escalation succeeds
      await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      // Duplicate fails
      const dupRes = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(dupRes.status).toBe(409);
    });
  });

  // ─── Arbitration Decision ────────────────────────────────────────────

  describe("POST /api/v1/admin/strikes/:strikeId/arbitration/decide", () => {
    it("overturns a strike and reinstates buyer", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-overturn/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      await request(app)
        .post(`/api/v1/admin/buyers/buyer-overturn/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "I was present" });

      await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      // Overturn the strike
      const decideRes = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/arbitration/decide`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ decision: "OVERTURNED" });

      expect(decideRes.status).toBe(200);
      expect(decideRes.body.success).toBe(true);
      expect(decideRes.body.strike.arbitrationDecision).toBe("OVERTURNED");
      expect(decideRes.body.queueItem.status).toBe("decided");
      expect(decideRes.body.queueItem.decision).toBe("OVERTURNED");
      expect(decideRes.body.message).toContain("Strike overturned");
    });

    it("upholds a strike and confirms penalty stands", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-uphold/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      await request(app)
        .post(`/api/v1/admin/buyers/buyer-uphold/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal" });

      await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      const decideRes = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/arbitration/decide`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ decision: "UPHELD" });

      expect(decideRes.status).toBe(200);
      expect(decideRes.body.strike.arbitrationDecision).toBe("UPHELD");
      expect(decideRes.body.message).toContain("Penalty stands");
    });

    it("rejects decision with invalid value", async () => {
      const res = await request(app)
        .post("/api/v1/admin/strikes/some-strike/arbitration/decide")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ decision: "INVALID" });

      expect(res.status).toBe(400);
    });

    it("rejects decision for non-escalated strike", async () => {
      const issueRes = await request(app)
        .post("/api/v1/admin/buyers/buyer-no-esc/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show" });
      const strikeId = issueRes.body.strike.id;

      await request(app)
        .post(`/api/v1/admin/buyers/buyer-no-esc/strikes/${strikeId}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal" });

      // Try to decide without escalating
      const res = await request(app)
        .post(`/api/v1/admin/strikes/${strikeId}/arbitration/decide`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ decision: "UPHELD" });

      expect(res.status).toBe(409);
    });
  });

  // ─── Arbitration Queue Listing ────────────────────────────────────────

  describe("GET /api/v1/admin/strikes/arbitration/queue", () => {
    it("lists all pending arbitration items", async () => {
      // Create two appeals and escalate them
      const issue1 = await request(app)
        .post("/api/v1/admin/buyers/buyer-q1/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show 1" });
      await request(app)
        .post(`/api/v1/admin/buyers/buyer-q1/strikes/${issue1.body.strike.id}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal 1" });
      await request(app)
        .post(`/api/v1/admin/strikes/${issue1.body.strike.id}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      const issue2 = await request(app)
        .post("/api/v1/admin/buyers/buyer-q2/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No-show 2" });
      await request(app)
        .post(`/api/v1/admin/buyers/buyer-q2/strikes/${issue2.body.strike.id}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Appeal 2" });
      await request(app)
        .post(`/api/v1/admin/strikes/${issue2.body.strike.id}/escalate`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      const queueRes = await request(app)
        .get("/api/v1/admin/strikes/arbitration/queue")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(queueRes.status).toBe(200);
      expect(queueRes.body.queue.length).toBe(2);
      expect(queueRes.body.total).toBe(2);

      // Filter by pending
      const pendingRes = await request(app)
        .get("/api/v1/admin/strikes/arbitration/queue?status=pending")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(pendingRes.body.queue.length).toBe(2);
    });
  });

  // ─── Full Workflow: Issue → Appeal → Escalate → Decide ───────────────

  it("completes the full no-show appeal workflow end-to-end", async () => {
    // 1. Issue strike
    const issueRes = await request(app)
      .post("/api/v1/admin/buyers/buyer-e2e/strikes")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "No-show penalty", intentId: "intent-e2e", slotId: "slot-e2e" });

    expect(issueRes.status).toBe(201);
    const strikeId = issueRes.body.strike.id;

    // 2. Appeal with evidence
    const appealRes = await request(app)
      .post(`/api/v1/admin/buyers/buyer-e2e/strikes/${strikeId}/appeal`)
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({
        reason: "GPS shows I was at the venue",
        evidence: ["gps-screenshot.png", "chat-with-host.png"],
      });

    expect(appealRes.status).toBe(200);
    expect(appealRes.body.strike.status).toBe("appealed");
    expect(appealRes.body.strike.appealEvidence?.length).toBe(2);

    // 3. Escalate to arbitration queue
    const escalateRes = await request(app)
      .post(`/api/v1/admin/strikes/${strikeId}/escalate`)
      .set("x-chronopay-admin-token", ADMIN_TOKEN);

    expect(escalateRes.status).toBe(200);
    expect(escalateRes.body.queueItem.status).toBe("pending");

    // 4. Verify item is in the queue
    const queueRes = await request(app)
      .get("/api/v1/admin/strikes/arbitration/queue?status=pending")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);

    expect(queueRes.body.queue.some((item: any) => item.strikeId === strikeId)).toBe(true);

    // 5. Decide: overturn the strike
    const decideRes = await request(app)
      .post(`/api/v1/admin/strikes/${strikeId}/arbitration/decide`)
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ decision: "OVERTURNED" });

    expect(decideRes.status).toBe(200);
    expect(decideRes.body.strike.arbitrationDecision).toBe("OVERTURNED");
    expect(decideRes.body.queueItem.status).toBe("decided");

    // 6. Verify the decided item is not in the pending queue
    const pendingAfter = await request(app)
      .get("/api/v1/admin/strikes/arbitration/queue?status=pending")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);

    expect(pendingAfter.body.queue.some((item: any) => item.strikeId === strikeId)).toBe(false);

    // 7. Verify it appears in full queue
    const allAfter = await request(app)
      .get("/api/v1/admin/strikes/arbitration/queue")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);

    const decidedItem = allAfter.body.queue.find((item: any) => item.strikeId === strikeId);
    expect(decidedItem).toBeDefined();
    expect(decidedItem.status).toBe("decided");
    expect(decidedItem.decision).toBe("OVERTURNED");
  });
});

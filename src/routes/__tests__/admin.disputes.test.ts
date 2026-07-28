import request from "supertest";
import { createApp } from "../../app.js";
import { resetDisputesState } from "../admin.js";

const app = createApp({ enableTestRoutes: true });
const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

describe("E2E Dispute Smoke Suite", () => {
  beforeEach(() => {
    resetDisputesState();
  });

  it("should open, evidence, adjudicate in favor of buyer, and update ledgers", async () => {
    // 1. Open Dispute
    const openRes = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    
    expect(openRes.status).toBe(201);
    expect(openRes.body.success).toBe(true);
    const disputeId = openRes.body.dispute.id;
    expect(openRes.body.dispute.status).toBe("OPEN");

    // 2. Upload Evidence
    const evidenceRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/evidence`)
      .set(adminHeaders)
      .send({ evidence: "receipt.png" });
    
    expect(evidenceRes.status).toBe(200);
    expect(evidenceRes.body.success).toBe(true);
    expect(evidenceRes.body.dispute.status).toBe("EVIDENCED");
    expect(evidenceRes.body.evidenceAnchor).toBeDefined();

    // 3. Adjudicate
    const adjudicateRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/adjudicate`)
      .set(adminHeaders)
      .send({ ruling: "BUYER_FAVOR", arbiter: "arbiter1" });
    
    expect(adjudicateRes.status).toBe(200);
    expect(adjudicateRes.body.success).toBe(true);
    expect(adjudicateRes.body.dispute.status).toBe("ADJUDICATED");
    expect(adjudicateRes.body.dispute.arbiter).toBe("arbiter1");
    expect(adjudicateRes.body.rulingAudit).toBeDefined();

    // 4. Assert final ledger balances
    // Initial balances were 1000 each. Buyer gets +100, Supplier gets -100
    expect(adjudicateRes.body.ledgers.buyer).toBe(1100);
    expect(adjudicateRes.body.ledgers.supplier).toBe(900);
  });

  it("should open, evidence, adjudicate in favor of supplier, and update ledgers", async () => {
    const openRes = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    
    const disputeId = openRes.body.dispute.id;

    await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/evidence`)
      .set(adminHeaders)
      .send({ evidence: "receipt.png" });
    
    const adjudicateRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/adjudicate`)
      .set(adminHeaders)
      .send({ ruling: "SUPPLIER_FAVOR", arbiter: "arbiter2" });
    
    expect(adjudicateRes.status).toBe(200);
    // Initial balances were 1000 each. Buyer gets -100, Supplier gets +100
    expect(adjudicateRes.body.ledgers.buyer).toBe(900);
    expect(adjudicateRes.body.ledgers.supplier).toBe(1100);
  });

  it("should handle appeal path", async () => {
    const openRes = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    
    const disputeId = openRes.body.dispute.id;

    const appealRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/appeal`)
      .set(adminHeaders);
    
    expect(appealRes.status).toBe(200);
    expect(appealRes.body.dispute.status).toBe("APPEALED");
  });

  it("should handle timeout", async () => {
    const openRes = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    
    const disputeId = openRes.body.dispute.id;

    const timeoutRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/timeout`)
      .set(adminHeaders);
    
    expect(timeoutRes.status).toBe(200);
    expect(timeoutRes.body.dispute.status).toBe("TIMEOUT");
  });

  it("should handle evidence upload failure edge case", async () => {
    const openRes = await request(app)
      .post("/api/v1/admin/disputes")
      .set(adminHeaders)
      .send({ buyerId: "b1", supplierId: "s1", amount: 100 });
    
    const disputeId = openRes.body.dispute.id;

    const evidenceRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/evidence`)
      .set(adminHeaders)
      .send({ evidence: "receipt.png", failUpload: true });
    
    expect(evidenceRes.status).toBe(500);
    expect(evidenceRes.body.success).toBe(false);
    expect(evidenceRes.body.error).toBe("Evidence upload failed");
  });

  it("should return 404 for non-existent disputes", async () => {
    const res1 = await request(app).post("/api/v1/admin/disputes/unknown/evidence").set(adminHeaders).send({});
    expect(res1.status).toBe(404);

    const res2 = await request(app).post("/api/v1/admin/disputes/unknown/adjudicate").set(adminHeaders).send({});
    expect(res2.status).toBe(404);

    const res3 = await request(app).post("/api/v1/admin/disputes/unknown/appeal").set(adminHeaders).send({});
    expect(res3.status).toBe(404);

    const res4 = await request(app).post("/api/v1/admin/disputes/unknown/timeout").set(adminHeaders).send({});
    expect(res4.status).toBe(404);
  });
});

import express from "express";
import request from "supertest";
import adminRouter from "../routes/admin.js";
import { resetPayoutQuarantineState } from "../services/quarantineStore.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

const app = buildApp();

describe("Admin payout quarantine endpoints", () => {
  beforeEach(() => {
    resetPayoutQuarantineState();
  });

  it("lists quarantined payouts and releases one by transaction id", async () => {
    const { getPayoutQuarantineService } = await import("../services/quarantineStore.js");
    const service = getPayoutQuarantineService();
    service.recordFailure({
      payoutId: "tx-77",
      supplierId: "supplier-alpha",
      errorClass: "NETWORK",
      errorMessage: "dns failure",
    });

    const listRes = await request(app)
      .get("/api/v1/admin/payouts/quarantine")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin");

    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.entries).toHaveLength(1);
    expect(listRes.body.entries[0].payoutId).toBe("tx-77");

    const releaseRes = await request(app)
      .post("/api/v1/admin/payouts/tx-77/quarantine/release")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .send({ reason: "Reviewed" });

    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.success).toBe(true);
    expect(releaseRes.body.released).toBe(true);
  });
});

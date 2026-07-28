import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { strikeService } from "../../services/strikeService.js";

const ADMIN_TOKEN = "strike-test-admin-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

describe("Admin Buyer Strike & Suspension Routes", () => {
  let app: express.Application;

  beforeEach(() => {
    strikeService.resetState();
    app = makeApp();
  });

  describe("POST /api/v1/admin/buyers/:buyerId/strikes", () => {
    it("requires admin token header", async () => {
      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-1/strikes")
        .send({ reason: "No show" });

      expect(res.status).toBe(401);
    });

    it("issues a strike successfully when authorized", async () => {
      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-1/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "No show for booking", intentId: "intent-123", slotId: "slot-456" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.strike.buyerId).toBe("buyer-1");
      expect(res.body.strike.reason).toBe("No show for booking");
      expect(res.body.autoSuspended).toBe(false);
    });

    it("triggers auto-suspension on 3rd strike", async () => {
      // 1st strike
      await request(app)
        .post("/api/v1/admin/buyers/buyer-suspend/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Strike 1" });

      // 2nd strike
      await request(app)
        .post("/api/v1/admin/buyers/buyer-suspend/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Strike 2" });

      // 3rd strike
      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-suspend/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Strike 3" });

      expect(res.status).toBe(201);
      expect(res.body.autoSuspended).toBe(true);
      expect(res.body.suspension.isSuspended).toBe(true);
    });
  });

  describe("GET /api/v1/admin/buyers/:buyerId/strikes", () => {
    it("retrieves strikes and suspension status", async () => {
      await strikeService.issueStrike({ buyerId: "buyer-get-test", reason: "Test strike" });

      const res = await request(app)
        .get("/api/v1/admin/buyers/buyer-get-test/strikes")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.buyerId).toBe("buyer-get-test");
      expect(res.body.activeStrikesCount).toBe(1);
      expect(res.body.strikes.length).toBe(1);
    });
  });

  describe("POST /api/v1/admin/buyers/:buyerId/strikes/:strikeId/appeal", () => {
    it("appeals a strike and lifts suspension when active strikes count drops", async () => {
      // Issue 3 strikes to trigger auto-suspension
      await strikeService.issueStrike({ buyerId: "buyer-appeal-route", reason: "S1" });
      await strikeService.issueStrike({ buyerId: "buyer-appeal-route", reason: "S2" });
      const s3 = await strikeService.issueStrike({ buyerId: "buyer-appeal-route", reason: "S3" });

      expect(strikeService.getBuyerSuspensionStatus("buyer-appeal-route").isSuspended).toBe(true);

      const res = await request(app)
        .post(`/api/v1/admin/buyers/buyer-appeal-route/strikes/${s3.strike.id}/appeal`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "System error during checkin" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.strike.status).toBe("appealed");
      expect(res.body.suspensionLifted).toBe(true);
      expect(res.body.suspension.isSuspended).toBe(false);
    });

    it("returns 400 when appeal reason is missing", async () => {
      const res = await request(app)
        .post("/api/v1/admin/buyers/b1/strikes/s1/appeal")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Appeal reason is required");
    });
  });

  describe("POST /api/v1/admin/buyers/:buyerId/reinstate", () => {
    it("reinstates suspended buyer and clears active strikes", async () => {
      await strikeService.issueStrike({ buyerId: "buyer-reinstate-route", reason: "S1" });
      await strikeService.issueStrike({ buyerId: "buyer-reinstate-route", reason: "S2" });
      await strikeService.issueStrike({ buyerId: "buyer-reinstate-route", reason: "S3" });

      const res = await request(app)
        .post("/api/v1/admin/buyers/buyer-reinstate-route/reinstate")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ reason: "Admin override after review", clearActiveStrikes: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.suspension.isSuspended).toBe(false);
      expect(res.body.rescindedStrikesCount).toBe(3);

      const statusAfter = strikeService.getBuyerSuspensionStatus("buyer-reinstate-route");
      expect(statusAfter.activeStrikesCount).toBe(0);
    });
  });

  describe("GET & PUT /api/v1/admin/strikes/config", () => {
    it("retrieves and updates strike config", async () => {
      const getRes = await request(app)
        .get("/api/v1/admin/strikes/config")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(getRes.status).toBe(200);
      expect(getRes.body.config.maxStrikesThreshold).toBe(3);

      const putRes = await request(app)
        .put("/api/v1/admin/strikes/config")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ maxStrikesThreshold: 4 });

      expect(putRes.status).toBe(200);
      expect(putRes.body.config.maxStrikesThreshold).toBe(4);
    });
  });
});

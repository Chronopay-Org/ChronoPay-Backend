import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { requireFreshMfa } from "../requireFreshMfa.js";
import { mfaService } from "../../services/mfaService.js";

describe("requireFreshMfa middleware — unexpected failures", () => {
  it("returns 500 when challenge verification fails unexpectedly", async () => {
    const app = express();
    app.get(
      "/protected",
      (req, _res, next) => {
        req.auth = { userId: "user-1", role: "customer", claims: {} };
        next();
      },
      requireFreshMfa(),
      (_req, res) => res.status(200).json({ success: true }),
    );

    const spy = jest.spyOn(mfaService, "verifyChallenge").mockRejectedValueOnce(new Error("boom"));

    const res = await request(app).get("/protected").set("x-chronopay-mfa", "some-token");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to verify MFA challenge" });

    spy.mockRestore();
  });
});
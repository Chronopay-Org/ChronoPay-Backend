import request from "supertest";
import app from "../index";
import express from "express";
import { timeoutMiddleware } from "../middleware/timeout";

describe("Request timeout middleware", () => {
  it("should return 503 if request exceeds default timeout", async () => {
    jest.setTimeout(20000);
    const slowApp = express();
    slowApp.use(timeoutMiddleware({ timeoutMs: 1000 }));
    slowApp.get("/slow", (req: any, res: any) => {
      setTimeout(() => res.json({ ok: true }), 1500); // 1.5s > 1s
    });
    const res = await request(slowApp).get("/slow");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it("should allow per-route timeout override", async () => {
    jest.setTimeout(20000);
    const fastApp = express();
    fastApp.use(timeoutMiddleware({ timeoutMs: 5000 }));
    fastApp.get("/long", (req: any, res: any) => {
      setTimeout(() => res.json({ ok: true }), 2000); // 2s < 5s
    });
    const res = await request(fastApp).get("/long");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("should not leak stack traces or partial data on timeout", async () => {
    jest.setTimeout(20000);
    const testApp = express();
    testApp.use(timeoutMiddleware({ timeoutMs: 1000 }));
    testApp.get("/leak", (req: any, res: any) => {
      setTimeout(() => res.json({ secret: "should not leak" }), 1500);
    });
    const res = await request(testApp).get("/leak");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/timed out/i);
    expect(res.body).not.toHaveProperty("secret");
  });
});

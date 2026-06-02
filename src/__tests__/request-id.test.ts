import express from "express";
import request from "supertest";
import { AppError } from "../errors/AppError.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { genericErrorHandler } from "../middleware/errorHandling.js";

describe("request id propagation", () => {
  it("reuses a valid x-request-id header and returns it in the response", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/", (req, res) => {
      // @ts-expect-error - Auto-fixed by script
      res.json({ requestId: req.requestId });
    });

    const response = await request(app)
      .get("/")
      .set("X-Request-Id", "req_12345678-1234-1234-1234-1234567890ab");

    expect(response.status).toBe(200);
    expect(response.body.requestId).toBe("req_12345678-1234-1234-1234-1234567890ab");
    expect(response.headers["x-request-id"]).toBe("req_12345678-1234-1234-1234-1234567890ab");
  });

  it("generates a new request id when the header is invalid", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/", (req, res) => {
      // @ts-expect-error - Auto-fixed by script
      res.json({ requestId: req.requestId });
    });

    const response = await request(app)
      .get("/")
      .set("X-Request-Id", "invalid request id");

    expect(response.status).toBe(200);
    expect(response.body.requestId).toMatch(/^req_[0-9a-fA-F-]{36}$/);
    expect(response.headers["x-request-id"]).toBe(response.body.requestId);
  });

  it("includes request id in AppError responses", async () => {
    const app = express();

    app.use(requestIdMiddleware);
    app.get("/", (_req, _res, next) => {
      next(new AppError("Broken", 418, "TEAPOT"));
    });
    app.use(genericErrorHandler);

    const response = await request(app)
      .get("/")
      .set("X-Request-Id", "req_abcdef12-3456-7890-abcd-ef1234567890");

    expect(response.status).toBe(418);
    expect(response.body.requestId).toBe("req_abcdef12-3456-7890-abcd-ef1234567890");
    expect(response.body.code).toBe("TEAPOT");
    expect(response.body.success).toBe(false);
  });
});

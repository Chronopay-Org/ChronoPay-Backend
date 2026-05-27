import express from "express";
import request from "supertest";
import { createContentNegotiationMiddleware } from "../contentNegotiation.js";

function createHarness(options?: { excludePaths?: string[] }) {
  const app = express();

  app.use(createContentNegotiationMiddleware(options));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/echo", (req, res) => {
    res.status(200).json({ body: req.body ?? null });
  });

  app.post("/webhooks/stripe/events", (_req, res) => {
    res.status(200).json({ bypassed: true });
  });

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const error = err as {
        statusCode?: number;
        code?: string;
        message?: string;
      };
      res.status(error.statusCode ?? 500).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    },
  );

  return app;
}

describe("content negotiation middleware", () => {
  it("rejects POST requests with unsupported content types before JSON parsing", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "text/plain")
      .set("Accept", "application/json")
      .send("not json");

    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({
      success: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      error: "Content-Type must be application/json",
    });
  });

  it("rejects POST requests that omit Content-Type", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Accept", "application/json");

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("allows JSON content types with charset parameters", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Accept", "application/json")
      .send(JSON.stringify({ invoiceId: "inv_123" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { invoiceId: "inv_123" } });
  });

  it("allows wildcard Accept headers", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Accept", "*/*")
      .send({ ok: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { ok: true } });
  });

  it("rejects body requests that do not accept JSON responses", async () => {
    const res = await request(createHarness())
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Accept", "text/html")
      .send({ ok: true });

    expect(res.status).toBe(406);
    expect(res.body).toMatchObject({
      success: false,
      code: "NOT_ACCEPTABLE",
      error: "Accept header must include application/json",
    });
  });

  it("does not require JSON Accept headers for GET requests", async () => {
    const res = await request(createHarness())
      .get("/health")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("bypasses configured excluded path prefixes", async () => {
    const res = await request(createHarness({ excludePaths: ["/webhooks"] }))
      .post("/webhooks/stripe/events")
      .set("Content-Type", "text/plain")
      .set("Accept", "text/html")
      .send("raw webhook body");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bypassed: true });
  });
});

import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import type { CORSConfig } from "../../config/cors.js";
import { createCORSMiddleware } from "../cors.js";

const corsConfig: CORSConfig = {
  allowedOrigins: ["https://allowed.example.com"],
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Idempotency-Key",
    "x-chronopay-mfa",
  ],
  allowCredentials: true,
  maxAge: 3600,
};

function createTestApp() {
  const app = express();
  app.use((_req, res, next) => {
    res.vary("Accept-Encoding");
    next();
  });
  app.use(createCORSMiddleware(corsConfig));
  app.get("/test", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS middleware", () => {
  it("allows API-specific headers on preflight and exposes response headers", async () => {
    const response = await request(createTestApp())
      .options("/test")
      .set("Origin", "https://allowed.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set(
        "Access-Control-Request-Headers",
        "idempotency-key, x-chronopay-mfa",
      );

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-headers"]).toContain(
      "Idempotency-Key",
    );
    expect(response.headers["access-control-allow-headers"]).toContain(
      "x-chronopay-mfa",
    );
    expect(response.headers["access-control-expose-headers"]).toContain(
      "RateLimit-Remaining",
    );
    expect(response.headers["access-control-expose-headers"]).toContain(
      "X-Cache",
    );
  });

  it("adds Origin to Vary without replacing existing values", async () => {
    const response = await request(createTestApp())
      .get("/test")
      .set("Origin", "https://allowed.example.com");

    expect(response.headers.vary).toEqual(
      expect.stringMatching(/Accept-Encoding/i),
    );
    expect(response.headers.vary).toEqual(expect.stringMatching(/Origin/i));
  });

  it("adds Vary: Origin even when the request has no Origin", async () => {
    const response = await request(createTestApp()).get("/test");

    expect(response.headers.vary).toEqual(expect.stringMatching(/Origin/i));
  });
});

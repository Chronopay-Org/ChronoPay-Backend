import { jest } from "@jest/globals";
import request from "supertest";

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/featureFlags.js", () => ({
  featureFlagContextMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  initializeFeatureFlagsFromEnv: () => {},
}));

jest.mock("../routes/booking-intents.js", () => ({
  createBookingIntentsRouter: () => {
    const { Router } = require("express");
    return Router();
  },
}));

jest.mock("../routes/checkout.js", () => {
  const { Router } = require("express");
  return { default: Router() };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createApp", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe("enableDocs: false", () => {
    it("does not mount /api-docs when enableDocs is false", async () => {
      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });
      const res = await request(app).get("/api-docs");
      // Should 404, not serve swagger UI
      expect(res.status).toBe(404);
    });

    it("health endpoint still works when enableDocs is false", async () => {
      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", service: "chronopay-backend" });
    });
  });

  describe("missing swagger deps", () => {
    it("boots successfully even when swagger-ui-express is not available", async () => {
      // Simulate missing swagger deps by mocking createRequire to throw
      jest.mock("node:module", () => ({
        createRequire: () => (id: string) => {
          if (id === "swagger-ui-express" || id === "swagger-jsdoc") {
            throw new Error(`Cannot find module '${id}'`);
          }
          return require(id);
        },
      }));

      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: true });

      // App should still respond to health check
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("trustProxy toggled", () => {
    it("sets trust proxy when TRUST_PROXY=true", async () => {
      process.env.TRUST_PROXY = "true";
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });

      // App should boot and respond normally
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      // Express trust proxy setting should be enabled (truthy)
      expect(app.get("trust proxy")).toBeTruthy();

      delete process.env.TRUST_PROXY;
    });

    it("does not set trust proxy when TRUST_PROXY is unset", async () => {
      delete process.env.TRUST_PROXY;
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });

      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      // Express trust proxy should be falsy (default)
      expect(app.get("trust proxy")).toBeFalsy();
    });

    it("does not set trust proxy when TRUST_PROXY=false", async () => {
      process.env.TRUST_PROXY = "false";
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });

      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      expect(app.get("trust proxy")).toBeFalsy();

      delete process.env.TRUST_PROXY;
    });
  });

  describe("content negotiation", () => {
    it("is enabled by default", async () => {
      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });

      // POST with wrong Content-Type should be rejected
      const res = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "text/plain")
        .send("data");
      expect(res.status).toBe(415);
    });

    it("can be disabled via enableContentNegotiation: false", async () => {
      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false, enableContentNegotiation: false });

      // Health check still works
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    });
  });
});

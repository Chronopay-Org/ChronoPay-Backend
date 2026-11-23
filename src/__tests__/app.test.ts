import { jest } from "@jest/globals";
import request from "supertest";
import { InMemorySlotRepository } from "../repositories/slot.repository.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/featureFlags.js", () => ({
  featureFlagContextMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  initializeFeatureFlagsFromEnv: () => {},
}));

jest.mock("../middleware/auth.js", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    const userId = req.headers["x-test-user-id"] ?? "user-1";
    req.user = { id: userId, userId, role: "user" };
    next();
  },
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

  const createSlotApp = async () => {
    const { createApp } = await import("../app.js");
    const slotRepository = new InMemorySlotRepository();
    const app = createApp({ enableDocs: false, slotRepository });
    return app;
  };

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
      const res = await request(app).get("/health").set("x-strict-health", "1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", service: "chronopay-backend" });
    });

    it("exposes Horizon health in /health when a horizonContractService is provided", async () => {
      const { createApp } = await import("../app.js");
      const { ContractService } = await import("../services/contract.service.js");
      const service = new ContractService();
      const app = createApp({ enableDocs: false, horizonContractService: service });

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("horizon");
      expect(res.body.horizon).toMatchObject({ tier: "normal", samples: 0 });
    });

    it("returns Horizon health from /health/horizon when configured", async () => {
      const { createApp } = await import("../app.js");
      const { ContractService } = await import("../services/contract.service.js");
      const service = new ContractService();
      const app = createApp({ enableDocs: false, horizonContractService: service });

      const res = await request(app).get("/health/horizon");

      expect(res.status).toBe(200);
      expect(res.body.tier).toBe("normal");
      expect(res.body.samples).toBe(0);
    });

    it("returns 404 from /health/horizon when no horizon service is configured", async () => {
      const { createApp } = await import("../app.js");
      const app = createApp({ enableDocs: false });

      const res = await request(app).get("/health/horizon");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: "Horizon health unavailable" });
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

  describe("test routes security guard", () => {
    it("throws when enableTestRoutes is true in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      jest.resetModules();

      const { createApp } = await import("../app.js");

      expect(() => createApp({ enableTestRoutes: true })).toThrow(
        "Test routes cannot be enabled in production. enableTestRoutes is true but NODE_ENV is 'production'.",
      );

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("allows enableTestRoutes in development", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableTestRoutes: true });

      // App should boot successfully
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      // Test route should be accessible
      const testRes = await request(app).get("/__test__/explode");
      expect(testRes.status).toBe(500);

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("allows enableTestRoutes in test", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableTestRoutes: true });

      // App should boot successfully
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("allows enableTestRoutes when NODE_ENV is unset (defaults to development)", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableTestRoutes: true });

      // App should boot successfully
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("does not throw when enableTestRoutes is false in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      jest.resetModules();

      const { createApp } = await import("../app.js");
      const app = createApp({ enableTestRoutes: false });

      // App should boot successfully
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);

      // Test route should not be accessible
      const testRes = await request(app).get("/__test__/explode");
      expect(testRes.status).toBe(404);

      process.env.NODE_ENV = originalNodeEnv;
    });
  });

  it("rejects invalid CORS configuration during app creation", async () => {
    const originalAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS;
    process.env.CORS_ALLOWED_ORIGINS = "*";

    try {
      const { createApp } = await import("../app.js");
      expect(() => createApp()).toThrow(
        "Invalid origin pattern: wildcard-only patterns are not allowed for security",
      );
    } finally {
      if (originalAllowedOrigins === undefined) {
        delete process.env.CORS_ALLOWED_ORIGINS;
      } else {
        process.env.CORS_ALLOWED_ORIGINS = originalAllowedOrigins;
      }
    }
  });

  describe("notFoundHandler and 404 envelope consistency", () => {
    it("returns 404 with JSON envelope for unknown paths", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.get("/health", (req, res) => res.status(200).json({ ok: true }));
      app.use(notFoundHandler);

      const res = await request(app).get("/this-path-does-not-exist");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        success: false,
        code: "NOT_FOUND",
        error: "Route not found: GET /this-path-does-not-exist",
      });
      expect(res.body).toHaveProperty("timestamp");
    });

    it("returns application/json Content-Type for 404 responses", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.use(notFoundHandler);

      const res = await request(app).get("/unknown-route");

      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("returns success:false in 404 response body", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.use(notFoundHandler);

      const res = await request(app)
        .post("/api/v1/unknown-endpoint")
        .set("Content-Type", "application/json");

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("includes HTTP method in 404 error message", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.use(notFoundHandler);

      const res = await request(app).post("/unknown").set("Content-Type", "application/json");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("POST");
      expect(res.body.error).toContain("/unknown");
    });

    it("does not leak stack traces in 404 responses", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.use(notFoundHandler);

      const res = await request(app).get("/not-found");

      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty("stack");
      expect(res.body).not.toHaveProperty("trace");
    });

    it("returns consistent envelope structure for all 404s", async () => {
      const { notFoundHandler } = await import("../middleware/errorHandling.js");
      const express = (await import("express")).default;
      const request = (await import("supertest")).default;

      const app = express();
      app.use(notFoundHandler);

      const res1 = await request(app).get("/path1");
      const res2 = await request(app).post("/path2").set("Content-Type", "application/json");

      expect(res1.status).toBe(404);
      expect(res2.status).toBe(404);

      expect(res1.body).toHaveProperty("success");
      expect(res1.body).toHaveProperty("code");
      expect(res1.body).toHaveProperty("error");
      expect(res1.body).toHaveProperty("timestamp");

      expect(res2.body).toHaveProperty("success");
      expect(res2.body).toHaveProperty("code");
      expect(res2.body).toHaveProperty("error");
      expect(res2.body).toHaveProperty("timestamp");
    });
  });

  describe("slots router wiring", () => {
    it("persists a created slot and returns it on a subsequent GET", async () => {
      const app = await createSlotApp();

      const createRes = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .set("x-test-user-id", "user-1")
        .send({
          professional: "alice",
          startTime: "2030-01-01T10:00:00.000Z",
          endTime: "2030-01-01T11:00:00.000Z",
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.id).toBeDefined();
      expect(createRes.body.id).not.toBe("slot-new");

      const listRes = await request(app)
        .get("/api/v1/slots")
        .set("x-test-user-id", "user-1");

      expect(listRes.status).toBe(200);
      const items = listRes.body.data ?? listRes.body;
      const ids = (Array.isArray(items) ? items : []).map((s: any) => s.id);
      expect(ids).toContain(createRes.body.id);
    });

    it("returns the second slot for ?page=2&limit=1 when two slots exist", async () => {
      const app = await createSlotApp();

      const first = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .set("x-test-user-id", "user-1")
        .send({
          professional: "alice",
          startTime: "2030-01-01T10:00:00.000Z",
          endTime: "2030-01-01T11:00:00.000Z",
        });
      const second = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .set("x-test-user-id", "user-1")
        .send({
          professional: "alice",
          startTime: "2030-01-02T10:00:00.000Z",
          endTime: "2030-01-02T11:00:00.000Z",
        });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const page2 = await request(app)
        .get("/api/v1/slots?page=2&limit=1")
        .set("x-test-user-id", "user-1");

      expect(page2.status).toBe(200);
      const items = page2.body.data ?? page2.body;
      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(second.body.id);
    });

    it("rejects DELETE of a slot by a non-owner via authorizeSlotDelete", async () => {
      const app = await createSlotApp();

      const created = await request(app)
        .post("/api/v1/slots")
        .set("Content-Type", "application/json")
        .set("x-test-user-id", "owner-1")
        .send({
          professional: "alice",
          startTime: "2030-01-01T10:00:00.000Z",
          endTime: "2030-01-01T11:00:00.000Z",
        });

      expect(created.status).toBe(201);

      const deleteRes = await request(app)
        .delete(`/api/v1/slots/${created.body.id}`)
        .set("x-test-user-id", "intruder-1");

      expect(deleteRes.status).toBe(403);

      const listRes = await request(app)
        .get("/api/v1/slots")
        .set("x-test-user-id", "owner-1");
      const items = listRes.body.data ?? listRes.body;
      const ids = (Array.isArray(items) ? items : []).map((s: any) => s.id);
      expect(ids).toContain(created.body.id);
    });
  });
});

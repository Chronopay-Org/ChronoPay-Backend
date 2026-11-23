/**
 * graceWindow.routes.test.ts
 * --------------------------
 * Integration tests for the grace-window admin REST endpoints.
 *
 * Routes under test:
 *   GET    /api/v1/admin/slot-categories/grace-windows
 *   GET    /api/v1/admin/slot-categories/grace-windows/history
 *   GET    /api/v1/admin/slot-categories/:category/grace-window
 *   PUT    /api/v1/admin/slot-categories/:category/grace-window
 *   DELETE /api/v1/admin/slot-categories/:category/grace-window
 *   GET    /api/v1/admin/slot-categories/:category/grace-window/history
 */

import request from "supertest";
import express from "express";
import {
  createGraceWindowRouter,
} from "../routes/graceWindow.js";
import {
  GraceWindowService,
  InMemoryGraceWindowStore,
  DEFAULT_GRACE_WINDOW_SECONDS,
  MIN_GRACE_WINDOW_SECONDS,
  MAX_GRACE_WINDOW_SECONDS,
} from "../services/graceWindowService.js";

// ─── Test app factory ─────────────────────────────────────────────────────────

const ADMIN_TOKEN = "test-admin-token-abc";

function makeApp(): { app: express.Express; service: GraceWindowService } {
  process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

  const store = new InMemoryGraceWindowStore();
  const service = new GraceWindowService({
    store,
    nowIso: () => "2026-07-28T12:00:00.000Z",
    auditLogger: { log: async () => {} } as any,
    generateId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });

  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", createGraceWindowRouter(service));

  return { app, service };
}

const adminHeader = { "x-chronopay-admin-token": ADMIN_TOKEN };

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe("Auth guard — all routes require admin token", () => {
  const routes = [
    { method: "get", path: "/api/v1/admin/slot-categories/grace-windows" },
    { method: "get", path: "/api/v1/admin/slot-categories/grace-windows/history" },
    { method: "get", path: "/api/v1/admin/slot-categories/medical/grace-window" },
    { method: "put", path: "/api/v1/admin/slot-categories/medical/grace-window" },
    { method: "delete", path: "/api/v1/admin/slot-categories/medical/grace-window" },
    { method: "get", path: "/api/v1/admin/slot-categories/medical/grace-window/history" },
  ];

  it.each(routes)("$method $path returns 401 without token", async ({ method, path }) => {
    const { app } = makeApp();
    const res = await (request(app) as any)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(routes)("$method $path returns 403 with wrong token", async ({ method, path }) => {
    const { app } = makeApp();
    const res = await (request(app) as any)[method](path)
      .set("x-chronopay-admin-token", "wrong-token")
      .send({});
    expect(res.status).toBe(403);
  });
});

// ─── GET /slot-categories/grace-windows ───────────────────────────────────────

describe("GET /api/v1/admin/slot-categories/grace-windows", () => {
  it("returns empty list when nothing configured", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.configs).toEqual([]);
    expect(res.body.defaultGraceWindowSeconds).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns all configured categories", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
  });
});

// ─── GET /slot-categories/grace-windows/history ───────────────────────────────

describe("GET /api/v1/admin/slot-categories/grace-windows/history", () => {
  it("returns empty history initially", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("returns all history entries across categories", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "b" });

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.history).toHaveLength(2);
  });

  it("paginates with limit and offset", async () => {
    const { app, service } = makeApp();
    for (let i = 0; i < 5; i++) {
      await service.set({ category: `cat-${i}`, graceWindowSeconds: 300 + i, changedBy: "a" });
    }
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history?limit=2&offset=1")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });

  it("returns 400 for invalid limit", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history?limit=0")
      .set(adminHeader);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 for negative offset", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history?offset=-1")
      .set(adminHeader);
    expect(res.status).toBe(400);
  });

  it("returns 400 for limit > 200", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/grace-windows/history?limit=201")
      .set(adminHeader);
    expect(res.status).toBe(400);
  });
});

// ─── GET /slot-categories/:category/grace-window ──────────────────────────────

describe("GET /api/v1/admin/slot-categories/:category/grace-window", () => {
  it("returns default when category has no config", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.graceWindowSeconds).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.config).toBeNull();
  });

  it("returns configured value when override exists", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.graceWindowSeconds).toBe(600);
    expect(res.body.isDefault).toBe(false);
    expect(res.body.config).not.toBeNull();
  });
});

// ─── PUT /slot-categories/:category/grace-window ──────────────────────────────

describe("PUT /api/v1/admin/slot-categories/:category/grace-window", () => {
  it("creates a new config and returns 200", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.config.category).toBe("fitness");
    expect(res.body.config.graceWindowSeconds).toBe(300);
  });

  it("updates an existing config", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });

    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 600, reason: "Peak hours adjustment" });
    expect(res.status).toBe(200);
    expect(res.body.config.graceWindowSeconds).toBe(600);
  });

  it("accepts optional reason field", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/beauty/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 180, reason: "Client request" });
    expect(res.status).toBe(200);
  });

  it("returns 400 when graceWindowSeconds is missing", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/graceWindowSeconds is required/);
  });

  it("returns 422 for non-finite value", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: "not-a-number" });
    expect(res.status).toBe(422);
  });

  it("returns 422 for float value", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300.5 });
    expect(res.status).toBe(422);
  });

  it("returns 422 for value below minimum", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 0 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/between/);
  });

  it("returns 422 for value above maximum", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS + 1 });
    expect(res.status).toBe(422);
  });

  it("accepts minimum allowed value", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/other/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: MIN_GRACE_WINDOW_SECONDS });
    expect(res.status).toBe(200);
  });

  it("accepts maximum allowed value", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/other/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS });
    expect(res.status).toBe(200);
  });

  it("returns 422 when reason is a number", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300, reason: 42 });
    expect(res.status).toBe(422);
  });

  it("returns 422 when reason exceeds 500 chars", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300, reason: "x".repeat(501) });
    expect(res.status).toBe(422);
  });
});

// ─── DELETE /slot-categories/:category/grace-window ───────────────────────────

describe("DELETE /api/v1/admin/slot-categories/:category/grace-window", () => {
  it("returns 404 when category has no config", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/nonexistent/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("deletes existing config and returns 200", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });

    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/medical/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.defaultGraceWindowSeconds).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("after deletion, GET returns isDefault=true", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await request(app)
      .delete("/api/v1/admin/slot-categories/medical/grace-window")
      .set(adminHeader);

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window")
      .set(adminHeader);
    expect(res.body.isDefault).toBe(true);
    expect(res.body.graceWindowSeconds).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("accepts optional reason in body", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });

    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ reason: "Cleaning up old config" });
    expect(res.status).toBe(200);
  });

  it("returns 422 when reason is not a string", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });

    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ reason: 123 });
    expect(res.status).toBe(422);
  });
});

// ─── GET /slot-categories/:category/grace-window/history ──────────────────────

describe("GET /api/v1/admin/slot-categories/:category/grace-window/history", () => {
  it("returns empty history for category with no changes", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.category).toBe("medical");
  });

  it("returns history entries for the category", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "b" });

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history")
      .set(adminHeader);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.history).toHaveLength(2);
    // Most-recent first.
    expect(res.body.history[0].newGraceWindowSeconds).toBe(600);
  });

  it("does not include history from other categories", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 600, changedBy: "b" });

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history")
      .set(adminHeader);
    expect(res.body.total).toBe(1);
    expect(res.body.history[0].category).toBe("medical");
  });

  it("paginates correctly", async () => {
    const { app, service } = makeApp();
    for (let i = 0; i < 5; i++) {
      await service.set({ category: "medical", graceWindowSeconds: 100 + i * 100, changedBy: "a" });
    }

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history?limit=2&offset=0")
      .set(adminHeader);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it("returns 400 for invalid limit", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history?limit=abc")
      .set(adminHeader);
    expect(res.status).toBe(400);
  });

  it("includes deletion event in history", async () => {
    const { app, service } = makeApp();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.delete("medical", "admin", "cleanup");

    const res = await request(app)
      .get("/api/v1/admin/slot-categories/medical/grace-window/history")
      .set(adminHeader);
    expect(res.body.total).toBe(2);
  });
});

// ─── 500-error paths ─────────────────────────────────────────────────────────

describe("500-error handling — PUT and DELETE propagate unexpected errors", () => {
  it("PUT returns 500 when service.set throws an unexpected error", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
    const throwingService = {
      get: () => undefined,
      list: () => [],
      getHistory: () => [],
      resolve: () => 900,
      set: async () => { throw new Error("unexpected db error"); },
      delete: async () => false,
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/v1/admin", createGraceWindowRouter(throwingService));

    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300 });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/unexpected db error/);
  });

  it("DELETE returns 500 when service.delete throws an unexpected error", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
    const throwingService = {
      get: () => undefined,
      list: () => [],
      getHistory: () => [],
      resolve: () => 900,
      set: async () => ({}),
      delete: async () => { throw new Error("unexpected delete error"); },
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/v1/admin", createGraceWindowRouter(throwingService));

    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/unexpected delete error/);
  });

  it("PUT returns 422 when service.set throws a GraceWindowValidationError", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
    const { GraceWindowValidationError: GWVError } = await import(
      "../services/graceWindowService.js"
    );
    const throwingService = {
      get: () => undefined,
      list: () => [],
      getHistory: () => [],
      resolve: () => 900,
      set: async () => { throw new GWVError("service-level validation"); },
      delete: async () => false,
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/v1/admin", createGraceWindowRouter(throwingService));

    const res = await request(app)
      .put("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader)
      .send({ graceWindowSeconds: 300 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/service-level validation/);
  });

  it("DELETE returns 422 when service.delete throws a GraceWindowValidationError", async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
    const { GraceWindowValidationError: GWVError } = await import(
      "../services/graceWindowService.js"
    );
    const throwingService = {
      get: () => undefined,
      list: () => [],
      getHistory: () => [],
      resolve: () => 900,
      set: async () => ({}),
      delete: async () => { throw new GWVError("delete validation err"); },
    } as any;

    const app = express();
    app.use(express.json());
    app.use("/api/v1/admin", createGraceWindowRouter(throwingService));

    const res = await request(app)
      .delete("/api/v1/admin/slot-categories/fitness/grace-window")
      .set(adminHeader);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/delete validation err/);
  });
});

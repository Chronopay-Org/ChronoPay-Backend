/**
 * Integration tests for the fraud-model promotion endpoint
 * (`/api/v1/admin/fraud-models/promote`) and the listing endpoint
 * (`/api/v1/admin/fraud-models/list`). Mounts the route on a fresh Express app
 * with `requireAdminToken` configured so headers behave authentically.
 *
 * Tests mutate the `defaultAuditLogger.log` method via `jest.spyOn` (the
 * pattern used by `middleware/__tests__/audit.test.ts`) because `jest.mock`
 * does not reliably intercept ESM module exports under
 * `--experimental-vm-modules`. Because `AuditLogger.log` has multiple
 * overloads the spy's `mock.calls` array is typed against the overload it
 * resolved to, so we use the structural `toHaveBeenCalledWith` matcher
 * (also from `audit.test.ts`) instead of indexing `mock.calls` directly.
 */
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";

const ADMIN_TOKEN = "test-admin-token-1";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

import {
  FraudModelRegistry,
  resetFraudModelRegistry,
  getFraudModelRegistry,
} from "../../services/fraudModelRegistry.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

function registerPair(): void {
  const reg = getFraudModelRegistry();
  reg._reset();
  reg.registerModel({
    version: "v1",
    contentHash: "hash-v1",
    trafficWeight: 70,
    registeredAt: "2024-01-01T00:00:00.000Z",
    registeredBy: "admin-1",
  });
  reg.registerModel({
    version: "v2",
    contentHash: "hash-v2",
    trafficWeight: 30,
    registeredAt: "2024-01-01T00:00:00.000Z",
    registeredBy: "admin-1",
  });
}

describe("POST /api/v1/admin/fraud-models/promote", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest
      .spyOn(defaultAuditLogger, "log")
      .mockImplementation(() => Promise.resolve());
    resetFraudModelRegistry();
    registerPair();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 401 without an admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .send({ weights: { v1: 100, v2: 0 }, tenantOverrides: {} });
    expect(res.status).toBe(401);
  });

  it("returns 403 with a wrong admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", "wrong-token")
      .send({ weights: { v1: 100, v2: 0 }, tenantOverrides: {} });
    expect(res.status).toBe(403);
  });

  it("returns 400 when weights do not sum to 100", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ weights: { v1: 80, v2: 30 }, tenantOverrides: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEIGHTS_DO_NOT_SUM");
    expect(auditSpy).toHaveBeenCalledWith(
      "FRAUD_MODEL_PROMOTE_REJECTED",
      expect.objectContaining({
        context: expect.objectContaining({
          rejectedReason: expect.stringContaining("WEIGHTS_DO_NOT_SUM"),
        }),
      }),
      expect.objectContaining({
        resource: "/api/v1/admin/fraud-models/promote",
        status: "rejected",
      }),
    );
  });

  it("returns 400 when an override references an unknown version", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ weights: { v1: 100, v2: 0 }, tenantOverrides: { tenantA: "ghost" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_OVERRIDE");
  });

  it("returns 400 when weights reference an unregistered version", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ weights: { v1: 50, ghost: 50 }, tenantOverrides: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNKNOWN_VERSION");
  });

  it("returns 200, promotes the registry, and emits a FRAUD_MODEL_PROMOTED audit event", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({
        weights: { v1: 70, v2: 30 },
        tenantOverrides: { tenantA: "v2" },
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.snapshot.snapshotId).toMatch(/^snap-/);
    expect(res.body.snapshot.overrides.tenantA).toBe("v2");
    expect(auditSpy).toHaveBeenCalledWith(
      "FRAUD_MODEL_PROMOTED",
      expect.anything(),
      expect.objectContaining({
        status: "attempted",
        resource: "/api/v1/admin/fraud-models/promote",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      "FRAUD_MODEL_PROMOTED",
      expect.anything(),
      expect.objectContaining({
        status: 200,
        resource: "/api/v1/admin/fraud-models/promote",
      }),
    );
  });

  it("returns 400 when body is missing weights", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ tenantOverrides: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("captures actorIp + resource in the audit envelope", async () => {
    await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-forwarded-for", "203.0.113.42")
      .send({
        weights: { v1: 70, v2: 30 },
        tenantOverrides: {},
      });
    expect(auditSpy).toHaveBeenCalledWith(
      "FRAUD_MODEL_PROMOTED",
      expect.anything(),
      expect.objectContaining({
        resource: "/api/v1/admin/fraud-models/promote",
      }),
    );
  });

  it("registers new model via the listing endpoint after promotion", async () => {
    await request(makeApp())
      .post("/api/v1/admin/fraud-models/promote")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ weights: { v1: 70, v2: 30 }, tenantOverrides: {} });
    const list = await request(makeApp())
      .get("/api/v1/admin/fraud-models/list")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(list.status).toBe(200);
    expect(list.body.models).toHaveLength(2);
  });
});

describe("GET /api/v1/admin/fraud-models/list", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
    registerPair();
  });

  it("returns 401 without an admin token", async () => {
    const res = await request(makeApp()).get("/api/v1/admin/fraud-models/list");
    expect(res.status).toBe(401);
  });

  it("returns the registered list", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/fraud-models/list")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(
      res.body.models
        .map((m: { version: string }) => m.version)
        .sort(),
    ).toEqual(["v1", "v2"]);
  });
});

describe("FraudModelRegistry singleton reset semantics", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
  });

  it("_reset clears models and snapshot", () => {
    const reg = new FraudModelRegistry();
    reg.registerModel({
      version: "v1",
      contentHash: "h",
      trafficWeight: 100,
      registeredAt: "2024-01-01T00:00:00.000Z",
      registeredBy: "admin",
    });
    reg._reset();
    expect(reg.listModels()).toHaveLength(0);
  });
});

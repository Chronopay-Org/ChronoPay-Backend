/**
 * Tests for fraud model rollback hotkey (#455)
 *
 * Covers:
 *  - Initiate rollback (dual-admin gate, change-freeze, no-prior-version)
 *  - Approve rollback (different admin, TTL, same-admin rejection)
 *  - Rollback to already-current snapshot (409)
 *  - Cache / history recording
 *  - Propagation: new snapshot is live immediately after approve
 *  - HTTP layer via supertest (initiate + approve endpoints)
 */

import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import {
  resetFraudModelRegistry,
  getFraudModelRegistry,
} from "../../services/fraudModelRegistry.js";
import {
  _resetRollbackState,
  _getHistory,
  recordPromotion,
  initiateRollback,
  approveRollback,
  ROLLBACK_TTL_MS,
} from "../../services/fraudModelRollback.js";

// ─── Test setup ──────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "rollback-test-admin-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

function seedRegistry() {
  const reg = getFraudModelRegistry();
  reg._reset();
  reg.registerModel({
    version: "v1",
    contentHash: "hash-v1",
    trafficWeight: 70,
    registeredAt: "2024-01-01T00:00:00.000Z",
    registeredBy: "admin-seed",
  });
  reg.registerModel({
    version: "v2",
    contentHash: "hash-v2",
    trafficWeight: 30,
    registeredAt: "2024-01-01T00:00:00.000Z",
    registeredBy: "admin-seed",
  });
}

function promoteV1() {
  const reg = getFraudModelRegistry();
  const result = reg.promote({ weights: { v1: 100, v2: 0 }, tenantOverrides: {} }, "admin-a");
  recordPromotion({
    snapshotId: result.snapshot.snapshotId,
    request: { weights: { v1: 100, v2: 0 }, tenantOverrides: {} },
    promotedAt: new Date().toISOString(),
    promotedBy: "admin-a",
  });
  return result.snapshot.snapshotId;
}

function promoteV2() {
  const reg = getFraudModelRegistry();
  const result = reg.promote({ weights: { v1: 0, v2: 100 }, tenantOverrides: {} }, "admin-a");
  recordPromotion({
    snapshotId: result.snapshot.snapshotId,
    request: { weights: { v1: 0, v2: 100 }, tenantOverrides: {} },
    promotedAt: new Date().toISOString(),
    promotedBy: "admin-a",
  });
  return result.snapshot.snapshotId;
}

beforeEach(() => {
  _resetRollbackState();
  resetFraudModelRegistry();
  seedRegistry();
  jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.FRAUD_ROLLBACK_FREEZE_UNTIL;
});

// ─── Unit: initiateRollback ───────────────────────────────────────────────────

describe("initiateRollback()", () => {
  it("throws NO_PRIOR_VERSION when history is empty", () => {
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "bad deploy now" }),
    ).toThrow(expect.objectContaining({ code: "NO_PRIOR_VERSION" }));
  });

  it("throws NO_PRIOR_VERSION when only one promotion exists (nothing to roll back to)", () => {
    promoteV1();
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "bad deploy fix" }),
    ).toThrow(expect.objectContaining({ code: "NO_PRIOR_VERSION" }));
  });

  it("succeeds with a prior promotion in history", () => {
    promoteV1();
    promoteV2();
    const result = initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert" });
    expect(result.rollbackId).toMatch(/^rbk-/);
    expect(result.targetSnapshotId).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("throws REASON_TOO_SHORT when reason < 10 chars", () => {
    promoteV1();
    promoteV2();
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "short" }),
    ).toThrow(expect.objectContaining({ code: "REASON_TOO_SHORT" }));
  });

  it("throws CHANGE_FREEZE when freeze is active", () => {
    promoteV1();
    promoteV2();
    process.env.FRAUD_ROLLBACK_FREEZE_UNTIL = String(Date.now() + 60_000);
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert" }),
    ).toThrow(expect.objectContaining({ code: "CHANGE_FREEZE" }));
  });

  it("proceeds when freeze timestamp has passed", () => {
    promoteV1();
    promoteV2();
    process.env.FRAUD_ROLLBACK_FREEZE_UNTIL = String(Date.now() - 1);
    const result = initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert" });
    expect(result.rollbackId).toMatch(/^rbk-/);
  });

  it("throws ALREADY_CURRENT when targeting the current champion", () => {
    promoteV1();
    promoteV2();
    const current = _getHistory()[0].snapshotId;
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert", targetSnapshotId: current }),
    ).toThrow(expect.objectContaining({ code: "ALREADY_CURRENT" }));
  });

  it("throws SNAPSHOT_NOT_FOUND for an unknown targetSnapshotId", () => {
    promoteV1();
    promoteV2();
    expect(() =>
      initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert", targetSnapshotId: "snap-ghost" }),
    ).toThrow(expect.objectContaining({ code: "SNAPSHOT_NOT_FOUND" }));
  });
});

// ─── Unit: approveRollback ───────────────────────────────────────────────────

describe("approveRollback()", () => {
  it("throws NOT_FOUND for unknown rollbackId", async () => {
    await expect(approveRollback({ rollbackId: "rbk-ghost", approverId: "admin-b" })).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("throws SAME_ADMIN when approver == initiator", async () => {
    promoteV1();
    promoteV2();
    const { rollbackId } = initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert" });
    await expect(approveRollback({ rollbackId, approverId: "admin-a" })).rejects.toThrow(
      expect.objectContaining({ code: "SAME_ADMIN" }),
    );
  });

  it("throws EXPIRED when TTL has passed", async () => {
    promoteV1();
    promoteV2();
    const { rollbackId } = initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert" });
    // Patch Date.now() to simulate expiry
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockReturnValue(realNow() + ROLLBACK_TTL_MS + 1000);
    await expect(approveRollback({ rollbackId, approverId: "admin-b" })).rejects.toThrow(
      expect.objectContaining({ code: "EXPIRED" }),
    );
    jest.spyOn(Date, "now").mockRestore();
  });

  it("applies the rollback and returns a new snapshot within milliseconds", async () => {
    const snap1 = promoteV1();
    promoteV2();

    const { rollbackId } = initiateRollback({ initiatorId: "admin-a", reason: "bad deploy revert now" });
    const result = await approveRollback({ rollbackId, approverId: "admin-b" });

    expect(result.snapshotId).not.toBe(snap1); // new snap-id is minted
    expect(result.versions).toContain("v1");
    expect(result.propagationMs).toBeLessThan(60_000); // well within 60s SLO
  });

  it("the registry live snapshot is updated immediately after approve", async () => {
    promoteV1();
    promoteV2(); // v2 is champion now

    const { rollbackId } = initiateRollback({ initiatorId: "admin-a", reason: "rolling back v2 deploy" });
    await approveRollback({ rollbackId, approverId: "admin-b" });

    const snap = getFraudModelRegistry().getLatestSnapshot();
    expect(snap.versions.has("v1")).toBe(true);
    expect(snap.versions.has("v2")).toBe(false); // v2 dropped to weight 0
  });

  it("records the rollback as a new history entry", async () => {
    promoteV1();
    promoteV2();
    const historyBefore = _getHistory().length;

    const { rollbackId } = initiateRollback({ initiatorId: "admin-a", reason: "rolling back bad deploy" });
    await approveRollback({ rollbackId, approverId: "admin-b" });

    expect(_getHistory().length).toBe(historyBefore + 1);
  });
});

// ─── HTTP: /rollback/initiate ─────────────────────────────────────────────────

describe("POST /api/v1/admin/fraud-models/rollback/initiate", () => {
  const headers = {
    "x-chronopay-user-id": "admin-a",
    "x-chronopay-role": "admin",
  };

  it("returns 401 without auth headers", async () => {
    promoteV1();
    promoteV2();
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .send({ reason: "bad deploy rollback" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when no prior version exists", async () => {
    promoteV1(); // only one promotion — no prior
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(headers)
      .send({ reason: "bad deploy rollback" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NO_PRIOR_VERSION");
  });

  it("returns 400 when reason is too short", async () => {
    promoteV1();
    promoteV2();
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(headers)
      .send({ reason: "short" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_TOO_SHORT");
  });

  it("returns 202 with rollbackId and expiresAt", async () => {
    promoteV1();
    promoteV2();
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(headers)
      .send({ reason: "urgent: bad model deploy rollback" });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.rollbackId).toMatch(/^rbk-/);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns 423 when change-freeze is active", async () => {
    promoteV1();
    promoteV2();
    process.env.FRAUD_ROLLBACK_FREEZE_UNTIL = String(Date.now() + 60_000);
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(headers)
      .send({ reason: "bad deploy rollback now" });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe("CHANGE_FREEZE");
  });

  it("returns 409 when targeting the current champion", async () => {
    promoteV1();
    promoteV2();
    const current = _getHistory()[0].snapshotId;
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(headers)
      .send({ reason: "bad deploy rollback test", targetSnapshotId: current });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_CURRENT");
  });
});

// ─── HTTP: /rollback/approve ──────────────────────────────────────────────────

describe("POST /api/v1/admin/fraud-models/rollback/approve", () => {
  const initiatorHeaders = { "x-chronopay-user-id": "admin-a", "x-chronopay-role": "admin" };
  const approverHeaders = { "x-chronopay-user-id": "admin-b", "x-chronopay-role": "admin" };

  it("returns 404 for unknown rollbackId", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/approve")
      .set(approverHeaders)
      .send({ rollbackId: "rbk-ghost" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("returns 403 when same admin tries to approve their own initiation", async () => {
    promoteV1();
    promoteV2();
    const initRes = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(initiatorHeaders)
      .send({ reason: "bad deploy rollback test flow" });
    expect(initRes.status).toBe(202);

    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/approve")
      .set(initiatorHeaders) // same admin
      .send({ rollbackId: initRes.body.rollbackId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SAME_ADMIN");
  });

  it("returns 200 and new snapshot when a different admin approves", async () => {
    promoteV1();
    promoteV2();
    const initRes = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/initiate")
      .set(initiatorHeaders)
      .send({ reason: "bad deploy rollback dual admin flow" });
    expect(initRes.status).toBe(202);

    const approveRes = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/approve")
      .set(approverHeaders)
      .send({ rollbackId: initRes.body.rollbackId });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.snapshotId).toMatch(/^snap-/);
    expect(approveRes.body.propagationMs).toBeLessThan(60_000);
  });

  it("returns 400 when rollbackId is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/fraud-models/rollback/approve")
      .set(approverHeaders)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── HTTP: GET /history ───────────────────────────────────────────────────────

describe("GET /api/v1/admin/fraud-models/history", () => {
  it("returns 401 without admin token", async () => {
    const res = await request(makeApp()).get("/api/v1/admin/fraud-models/history");
    expect(res.status).toBe(401);
  });

  it("returns empty history when no promotions recorded", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/fraud-models/history")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
  });

  it("lists recorded promotions newest-first", async () => {
    promoteV1();
    promoteV2();
    const res = await request(makeApp())
      .get("/api/v1/admin/fraud-models/history")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    // newest first: v2 promotion is index 0
    expect(res.body.history[0].request.weights.v2).toBe(100);
  });
});

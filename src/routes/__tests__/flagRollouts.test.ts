/**
 * Integration tests for `/api/v1/admin/flag-rollouts` (#570). Mounts the
 * route on a fresh Express app with `requireAdminToken` configured so
 * headers behave authentically — same pattern as `fraudModels.test.ts`.
 */
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import flagRolloutsRouter from "../flagRollouts.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";
import { resetRolloutScheduleRegistry } from "../../flags/rolloutScheduleRegistry.js";

const ADMIN_TOKEN = "test-admin-token-rollouts";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/flag-rollouts", flagRolloutsRouter);
  return app;
}

const BASE_PAYLOAD = {
  flag: "CREATE_SLOT",
  tenantId: "tenant-a",
  environment: "production",
  actor: "alice",
  steps: [
    { percentage: 10, at: "2026-01-01T00:00:00.000Z" },
    { percentage: 100, at: "2026-01-02T00:00:00.000Z" },
  ],
};

describe("flag rollout admin routes", () => {
  let auditSpy: jest.SpiedFunction<typeof defaultAuditLogger.log>;

  beforeEach(() => {
    auditSpy = jest.spyOn(defaultAuditLogger, "log").mockImplementation(() => Promise.resolve());
    resetRolloutScheduleRegistry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("auth", () => {
    it("returns 401 without an admin token", async () => {
      const res = await request(makeApp()).post("/api/v1/admin/flag-rollouts").send(BASE_PAYLOAD);
      expect(res.status).toBe(401);
    });

    it("returns 403 with a wrong admin token", async () => {
      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", "wrong-token")
        .send(BASE_PAYLOAD);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /", () => {
    it("creates a schedule and emits an audit event", async () => {
      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.schedule.status).toBe("pending");
      expect(res.body.schedule.currentPercentage).toBe(0);
      expect(auditSpy).toHaveBeenCalledWith(
        "FLAG_ROLLOUT_CREATED",
        expect.anything(),
        expect.objectContaining({ status: 201, resource: "/api/v1/admin/flag-rollouts" }),
      );
    });

    it("returns 400 EMPTY_STEPS when the steps field is missing entirely", async () => {
      const { steps: _steps, ...withoutSteps } = BASE_PAYLOAD;
      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(withoutSteps);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("EMPTY_STEPS");
    });

    it("returns 400 with the registry's validation error code", async () => {
      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ ...BASE_PAYLOAD, flag: "NOT_REAL" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("UNKNOWN_FLAG");
    });

    it("propagates a non-registry error instead of swallowing it", async () => {
      const { getRolloutScheduleRegistry } = await import("../../flags/rolloutScheduleRegistry.js");
      const crashSpy = jest
        .spyOn(getRolloutScheduleRegistry(), "create")
        .mockImplementationOnce(() => {
          throw new Error("unexpected failure");
        });

      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      expect(res.status).toBe(500);
      crashSpy.mockRestore();
    });

    it("does not fail the request when the audit logger rejects", async () => {
      auditSpy.mockImplementation(() => Promise.reject(new Error("audit sink unavailable")));

      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      expect(res.status).toBe(201);
    });

    it("returns 409 for a duplicate in-flight schedule", async () => {
      await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SCHEDULE_IN_FLIGHT");
    });
  });

  describe("GET /", () => {
    it("lists schedules with optional filters", async () => {
      await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);
      await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ ...BASE_PAYLOAD, tenantId: "tenant-b" });

      const all = await request(makeApp())
        .get("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);
      expect(all.body.schedules).toHaveLength(2);

      const filtered = await request(makeApp())
        .get("/api/v1/admin/flag-rollouts?tenantId=tenant-b")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);
      expect(filtered.body.schedules).toHaveLength(1);
      expect(filtered.body.schedules[0].tenantId).toBe("tenant-b");
    });
  });

  describe("GET /:id", () => {
    it("returns a single schedule", async () => {
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);

      const res = await request(makeApp())
        .get(`/api/v1/admin/flag-rollouts/${created.body.schedule.id}`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.schedule.id).toBe(created.body.schedule.id);
    });

    it("returns 404 for an unknown id", async () => {
      const res = await request(makeApp())
        .get("/api/v1/admin/flag-rollouts/does-not-exist")
        .set("x-chronopay-admin-token", ADMIN_TOKEN);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    });
  });

  describe("POST /:id/pause and /:id/resume", () => {
    it("pauses and resumes a schedule", async () => {
      // Steps set far in the future so resume's catch-up has nothing due yet —
      // this test is about the pause/resume state machine, not the catch-up.
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({
          ...BASE_PAYLOAD,
          steps: [
            { percentage: 10, at: "2099-01-01T00:00:00.000Z" },
            { percentage: 100, at: "2099-01-02T00:00:00.000Z" },
          ],
        });
      const id = created.body.schedule.id;

      const paused = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/pause`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob", reason: "investigating errors" });
      expect(paused.status).toBe(200);
      expect(paused.body.schedule.status).toBe("paused");
      expect(auditSpy).toHaveBeenCalledWith(
        "FLAG_ROLLOUT_PAUSED",
        expect.anything(),
        expect.objectContaining({ status: 200 }),
      );

      const resumed = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/resume`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob" });
      expect(resumed.status).toBe(200);
      expect(resumed.body.schedule.status).toBe("pending");
    });

    it("returns 409 when pausing an already-paused schedule", async () => {
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);
      const id = created.body.schedule.id;

      await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/pause`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob" });

      const res = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/pause`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("ALREADY_PAUSED");
    });

    it("returns 409 when resuming a schedule that is not paused", async () => {
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);
      const id = created.body.schedule.id;

      const res = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/resume`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("INVALID_STATE_TRANSITION");
    });
  });

  describe("POST /:id/rollback", () => {
    it("rolls back a schedule and marks it terminal", async () => {
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);
      const id = created.body.schedule.id;

      // Manually advance the underlying registry so there is a step to roll back from.
      const { getRolloutScheduleRegistry } = await import("../../flags/rolloutScheduleRegistry.js");
      getRolloutScheduleRegistry().advanceDue(new Date("2026-01-01T00:00:00.000Z"));

      const res = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/rollback`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob", reason: "error rate spiked after step 1", toStepIndex: -1 });

      expect(res.status).toBe(200);
      expect(res.body.schedule.status).toBe("rolled_back");
      expect(res.body.schedule.currentPercentage).toBe(0);
      expect(auditSpy).toHaveBeenCalledWith(
        "FLAG_ROLLOUT_ROLLED_BACK",
        expect.anything(),
        expect.objectContaining({ status: 200 }),
      );
    });

    it("returns 400 when reason is missing", async () => {
      const created = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send(BASE_PAYLOAD);
      const id = created.body.schedule.id;

      const { getRolloutScheduleRegistry } = await import("../../flags/rolloutScheduleRegistry.js");
      getRolloutScheduleRegistry().advanceDue(new Date("2026-01-01T00:00:00.000Z"));

      const res = await request(makeApp())
        .post(`/api/v1/admin/flag-rollouts/${id}/rollback`)
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REASON");
    });

    it("returns 404 for an unknown id", async () => {
      const res = await request(makeApp())
        .post("/api/v1/admin/flag-rollouts/does-not-exist/rollback")
        .set("x-chronopay-admin-token", ADMIN_TOKEN)
        .send({ actor: "bob", reason: "some reason" });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("NOT_FOUND");
    });
  });
});

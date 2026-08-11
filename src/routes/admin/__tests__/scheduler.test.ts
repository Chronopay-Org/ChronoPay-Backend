/**
 * Comprehensive coverage for the admin scheduler control-plane
 * (`src/routes/admin/scheduler.ts`):
 *
 *   POST /pause    – auth, validation, happy path, Redis-unavailable
 *   POST /resume   – auth, validation, happy path, Redis-unavailable
 *   GET  /status   – auth, happy path, Redis-unavailable
 *
 * The redis flag store is mocked so we can drive every branch of the route.
 * The status bus is the real in-process EventEmitter so happy-path tests also
 * verify the broadcast fires.
 */
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  onSchedulerStatus,
  resetSchedulerStatusBus,
} from "../../../services/schedulerStatusBus.js";

/** Mirrors the real RedisUnavailableError shape for the mocked redis module. */
class FakeRedisUnavailableError extends Error {
  code = "REDIS_UNAVAILABLE";
}

const PAUSED_STATE = {
  paused: true,
  reason: "incident",
  initiatedBy: "alice",
  pausedAt: "2026-08-11T09:00:00.000Z",
};

const RESUME_STATE = {
  paused: false,
  initiatedBy: "alice",
  resumedAt: "2026-08-11T09:05:00.000Z",
};

const pauseSchedulerMock = jest.fn<any>();
const resumeSchedulerMock = jest.fn<any>();
const readSchedulerPauseStateMock = jest.fn<any>();

jest.unstable_mockModule("../../../redis.js", () => ({
  RedisUnavailableError: FakeRedisUnavailableError,
  SCHEDULER_PAUSED_KEY: "scheduler:paused",
  pauseScheduler: pauseSchedulerMock,
  resumeScheduler: resumeSchedulerMock,
  readSchedulerPauseState: readSchedulerPauseStateMock,
  setRedisClient: jest.fn(),
}));

const ADMIN_TOKEN = "test-admin-token-scheduler-route";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

let schedulerRouter: express.Router;

beforeAll(async () => {
  schedulerRouter = (await import("../scheduler.js")).default;
});

beforeEach(() => {
  jest.clearAllMocks();
  resetSchedulerStatusBus();
  pauseSchedulerMock.mockReset();
  resumeSchedulerMock.mockReset();
  readSchedulerPauseStateMock.mockReset();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/scheduler", schedulerRouter);
  return app;
}

describe("admin scheduler routes — authorization", () => {
  it("POST /pause returns 401 without an admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .send({ reason: "x", initiated_by: "alice" });
    expect(res.status).toBe(401);
  });

  it("POST /resume returns 401 without an admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/resume")
      .send({ initiated_by: "alice" });
    expect(res.status).toBe(401);
  });

  it("GET /status returns 401 without an admin token", async () => {
    const res = await request(makeApp()).get("/api/v1/admin/scheduler/status");
    expect(res.status).toBe(401);
  });

  it("POST /pause returns 403 with a wrong admin token", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", "wrong-token")
      .send({ reason: "x", initiated_by: "alice" });
    expect(res.status).toBe(403);
  });

  it("GET /status returns 403 with a wrong admin token", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/scheduler/status")
      .set("x-chronopay-admin-token", "wrong-token");
    expect(res.status).toBe(403);
  });
});

describe("admin scheduler routes — validation", () => {
  it("POST /pause returns 400 INVALID_REASON when reason is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ initiated_by: "alice" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_REASON" });
  });

  it("POST /pause returns 400 INVALID_REASON when reason is blank", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "   ", initiated_by: "alice" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REASON");
  });

  it("POST /pause returns 400 INVALID_INITIATED_BY when initiated_by is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "incident" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_INITIATED_BY");
  });

  it("POST /pause accepts camelCase initiatedBy", async () => {
    pauseSchedulerMock.mockResolvedValue(PAUSED_STATE);
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "incident", initiatedBy: "alice" });
    expect(res.status).toBe(200);
    expect(pauseSchedulerMock).toHaveBeenCalledWith({
      reason: "incident",
      initiatedBy: "alice",
    });
  });

  it("POST /pause returns 400 when body is not an object", async () => {
    // Route a text body through so req.body is a string (not an object);
    // readStringField must fall back to an empty source and reject.
    const app = express();
    app.use(express.text({ type: () => true }));
    app.use("/api/v1/admin/scheduler", schedulerRouter);

    const res = await request(app)
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send("just some text");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REASON");
  });

  it("POST /resume returns 400 INVALID_INITIATED_BY when initiated_by is missing", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/resume")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_INITIATED_BY");
  });
});

describe("admin scheduler routes — happy paths", () => {
  it("POST /pause returns 200 with the paused state and broadcasts", async () => {
    pauseSchedulerMock.mockResolvedValue(PAUSED_STATE);
    const events: unknown[] = [];
    onSchedulerStatus((event) => events.push(event));

    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "incident", initiated_by: "alice" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, scheduler: PAUSED_STATE });
    expect(pauseSchedulerMock).toHaveBeenCalledWith({
      reason: "incident",
      initiatedBy: "alice",
    });
    // The status bus must have been notified (fire-and-forget but synchronous emit).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ paused: true, reason: "incident" });
  });

  it("POST /resume returns 200 with the resumed state and broadcasts", async () => {
    resumeSchedulerMock.mockResolvedValue(RESUME_STATE);
    const events: unknown[] = [];
    onSchedulerStatus((event) => events.push(event));

    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/resume")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ initiated_by: "alice" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, scheduler: RESUME_STATE });
    expect(resumeSchedulerMock).toHaveBeenCalledWith({ initiatedBy: "alice" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ paused: false });
  });

  it("GET /status returns 200 with the current state (read path)", async () => {
    readSchedulerPauseStateMock.mockResolvedValue(PAUSED_STATE);
    const res = await request(makeApp())
      .get("/api/v1/admin/scheduler/status")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, scheduler: PAUSED_STATE });
  });
});

describe("admin scheduler routes — Redis unavailable (fail closed)", () => {
  it("POST /pause returns 503 REDIS_UNAVAILABLE", async () => {
    pauseSchedulerMock.mockRejectedValue(new FakeRedisUnavailableError("down"));
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "incident", initiated_by: "alice" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("REDIS_UNAVAILABLE");
  });

  it("POST /resume returns 503 REDIS_UNAVAILABLE", async () => {
    resumeSchedulerMock.mockRejectedValue(new FakeRedisUnavailableError("down"));
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/resume")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ initiated_by: "alice" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("REDIS_UNAVAILABLE");
  });

  it("GET /status returns 503 REDIS_UNAVAILABLE", async () => {
    readSchedulerPauseStateMock.mockRejectedValue(new FakeRedisUnavailableError("down"));
    const res = await request(makeApp())
      .get("/api/v1/admin/scheduler/status")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("REDIS_UNAVAILABLE");
  });
});

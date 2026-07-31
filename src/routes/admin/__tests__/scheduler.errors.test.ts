/**
 * Covers the scheduler control-plane's defensive 500 path: when the underlying
 * flag store throws something OTHER than RedisUnavailableError, the async
 * handlers must translate it to a clean 500 rather than leaking an unhandled
 * rejection. The redis module is mocked so we can inject a generic failure.
 */
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";

class FakeRedisUnavailableError extends Error {
  code = "REDIS_UNAVAILABLE";
}

jest.unstable_mockModule("../../../redis.js", () => ({
  RedisUnavailableError: FakeRedisUnavailableError,
  SCHEDULER_PAUSED_KEY: "scheduler:paused",
  pauseScheduler: jest.fn(async () => {
    throw new Error("boom");
  }),
  resumeScheduler: jest.fn(async () => {
    throw new Error("boom");
  }),
  readSchedulerPauseState: jest.fn(async () => {
    throw new Error("boom");
  }),
  setRedisClient: jest.fn(),
}));

const ADMIN_TOKEN = "test-admin-token-scheduler-errors";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

let schedulerRouter: express.Router;

beforeAll(async () => {
  schedulerRouter = (await import("../scheduler.js")).default;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin/scheduler", schedulerRouter);
  return app;
}

describe("admin scheduler routes — unexpected errors", () => {
  it("POST /pause returns 500 INTERNAL_ERROR on a non-Redis failure", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/pause")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ reason: "x", initiated_by: "alice" });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });

  it("POST /resume returns 500 INTERNAL_ERROR on a non-Redis failure", async () => {
    const res = await request(makeApp())
      .post("/api/v1/admin/scheduler/resume")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .send({ initiated_by: "alice" });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });

  it("GET /status returns 500 INTERNAL_ERROR on a non-Redis failure", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/scheduler/status")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

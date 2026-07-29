/**
 * gdprErasure.route.test.ts
 *
 * Integration tests for POST /api/v1/gdpr/erase.
 *
 * Uses supertest + the route factory with injected fakes so no real DB is
 * required.
 */

// @ts-nocheck
import { jest } from "@jest/globals";

// Mock the rate limiter so it doesn't pull in Redis/metrics dependencies.
jest.mock("../../middleware/rateLimiter.js", () => ({
  createAuthAwareRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from "express";
import request from "supertest";
import { createGdprErasureRouter } from "../../routes/gdprErasure.js";


import {
  InMemoryErasureEventLog,
} from "../../services/gdprErasure/eventLog.js";
import type { LegalHoldChecker, DbPool } from "../../services/gdprErasure/GdprErasureOrchestrator.js";

// ─── App factory ──────────────────────────────────────────────────────────────

function makeApp(opts: {
  held?: boolean;
  throwError?: Error;
  eventLog?: InMemoryErasureEventLog;
}) {
  const eventLog = opts.eventLog ?? new InMemoryErasureEventLog();

  // Minimal pool fake that returns empty rows.
  const fakeClient = {
    query: jest.fn(async (sql: string) => {
      if (opts.throwError && !sql.trim().match(/^(BEGIN|COMMIT|ROLLBACK)$/i)) {
        throw opts.throwError;
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };

  const pool: DbPool = {
    connect: jest.fn(async () => fakeClient),
  };

  const legalHold: LegalHoldChecker = {
    isHeld: jest.fn(async () => opts.held ?? false),
  };

  const router = createGdprErasureRouter({ pool, legalHold, eventLog });

  const app = express();
  app.use(express.json());
  app.use("/api/v1/gdpr/erase", router);

  return { app, eventLog, pool, legalHold, fakeClient };
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function asAdmin() {
  return {
    "x-chronopay-user-id": "admin-user-1",
    "x-chronopay-role": "admin",
  };
}

function asAuditor() {
  return {
    "x-chronopay-user-id": "auditor-user-1",
    "x-chronopay-role": "auditor",
  };
}

function asCustomer() {
  return {
    "x-chronopay-user-id": "customer-1",
    "x-chronopay-role": "customer",
  };
}

// ─── Authentication & authorization ──────────────────────────────────────────

describe("POST /api/v1/gdpr/erase — auth", () => {
  it("returns 401 when no auth headers are provided", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .send({ subjectId: "user-123" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when role is customer (insufficient permissions)", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asCustomer())
      .send({ subjectId: "user-123" });
    expect(res.status).toBe(403);
  });

  it("returns 403 when auditor attempts live erasure", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAuditor())
      .send({ subjectId: "user-123", dryRun: false });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("dry-run");
  });

  it("allows auditor with dryRun=true", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAuditor())
      .send({ subjectId: "user-123", dryRun: true });
    expect(res.status).toBe(200);
  });

  it("allows admin with live erasure", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: false });
    expect(res.status).toBe(200);
  });

  it("allows admin with dryRun=true", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: true });
    expect(res.status).toBe(200);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe("POST /api/v1/gdpr/erase — validation", () => {
  it("returns 400 when subjectId is missing", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when subjectId is an empty string", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when subjectId is a number", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: 12345 });
    expect(res.status).toBe(400);
  });

  it("trims leading/trailing whitespace from subjectId", async () => {
    const { app, eventLog } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "  user-abc  " });
    expect(res.status).toBe(200);
    // The stored receipt should use the trimmed ID.
    expect(eventLog.all()[0].subjectId).toBe("user-abc");
  });

  it("defaults dryRun to false when not provided", async () => {
    const { app, eventLog } = makeApp({});
    await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123" });
    expect(eventLog.all()[0].dryRun).toBe(false);
  });

  it("accepts dryRun as boolean true", async () => {
    const { app, eventLog } = makeApp({});
    await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: true });
    expect(eventLog.all()[0].dryRun).toBe(true);
  });

  it("accepts dryRun as string 'true'", async () => {
    const { app, eventLog } = makeApp({});
    await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: "true" });
    expect(eventLog.all()[0].dryRun).toBe(true);
  });
});

// ─── Success responses ────────────────────────────────────────────────────────

describe("POST /api/v1/gdpr/erase — success", () => {
  it("returns success:true with a receipt on live erasure", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.receipt).toBeDefined();
    expect(res.body.receipt.subjectId).toBe("user-123");
    expect(res.body.receipt.receiptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns plan array in dry-run responses", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
    expect(Array.isArray(res.body.plan)).toBe(true);
  });

  it("does NOT return plan in live erasure responses", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123", dryRun: false });

    expect(res.body.plan).toBeUndefined();
  });

  it("receipt has correct requestedBy matching the actor", async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set({ "x-chronopay-user-id": "admin-xyz", "x-chronopay-role": "admin" })
      .send({ subjectId: "user-123" });

    expect(res.body.receipt.requestedBy).toBe("admin-xyz");
  });
});

// ─── Error responses ──────────────────────────────────────────────────────────

describe("POST /api/v1/gdpr/erase — errors", () => {
  it("returns 409 with LEGAL_HOLD code when subject is held", async () => {
    const { app } = makeApp({ held: true });
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LEGAL_HOLD");
    expect(res.body.success).toBe(false);
  });

  it("returns 500 when an unexpected error occurs", async () => {
    const { app } = makeApp({ throwError: new Error("unexpected DB crash") });
    const res = await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-123" });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

// ─── Event log persistence ────────────────────────────────────────────────────

describe("POST /api/v1/gdpr/erase — event log", () => {
  it("writes a receipt to the event log", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { app } = makeApp({ eventLog });

    await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-456" });

    expect(eventLog.all()).toHaveLength(1);
    expect(eventLog.all()[0].subjectId).toBe("user-456");
  });

  it("writes a dry-run receipt with dryRun=true", async () => {
    const eventLog = new InMemoryErasureEventLog();
    const { app } = makeApp({ eventLog });

    await request(app)
      .post("/api/v1/gdpr/erase")
      .set(asAdmin())
      .send({ subjectId: "user-789", dryRun: true });

    expect(eventLog.all()[0].dryRun).toBe(true);
  });
});

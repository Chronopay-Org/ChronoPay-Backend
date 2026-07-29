// @ts-nocheck
/**
 * Integration tests for GDPR DSR SLA admin routes.
 *
 * Uses a minimal Express app that mounts only the admin router so we
 * avoid pulling in the full createApp() module graph (which has several
 * pre-existing unresolved imports under @ts-nocheck).
 */

import express from "express";
import request from "supertest";
import adminRouter, { setDsrSlaService } from "../admin.js";
import type { DsrRecord, DashboardSummary } from "../../services/dsrSlaService.js";

// ─── Minimal app factory ─────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

const app = buildApp();
const ADMIN = { "x-chronopay-admin-token": "test-admin-token" };

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<DsrRecord> = {}): DsrRecord {
  const now = new Date("2025-06-01T12:00:00Z");
  const dueAt = new Date("2025-07-01T12:00:00Z");
  return {
    id: "dsr-001", subjectId: "user-1", subjectEmail: "alice@example.com",
    requestType: "access", receivedAt: now, dueAt, status: "open",
    extensionReason: null, alert7dSent: false, alert3dSent: false, alert1dSent: false,
    resolvedAt: null, resolvedBy: null, resolutionReason: null, resolutionEvidence: null,
    notes: null, createdAt: now, updatedAt: now, daysRemaining: 30,
    msRemaining: 30 * 24 * 60 * 60 * 1000, ...overrides,
  };
}

function makeSummary(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    total: 5, open: 2, inProgress: 1, resolved: 1,
    extended: 1, rejected: 0, overdue: 0,
    dueIn7Days: 1, dueIn3Days: 0, dueIn1Day: 0, ...overrides,
  };
}

// ─── Mock service factory ─────────────────────────────────────────────────────

function makeMockService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    create: async () => makeRecord(),
    updateStatus: async () => makeRecord({ status: "in_progress" }),
    resolve: async () => makeRecord({ status: "resolved" }),
    extend: async () => makeRecord({ status: "extended" }),
    reopen: async () => makeRecord({ status: "open" }),
    findById: async () => makeRecord(),
    list: async () => [makeRecord()],
    getDashboardSummary: async () => makeSummary(),
    markAlertSent: async () => {},
    findPendingAlerts: async () => [],
    findDueSoon: async () => [],
    ...overrides,
  } as any;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let mockSvc: ReturnType<typeof makeMockService>;

beforeEach(() => {
  process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
  mockSvc = makeMockService();
  setDsrSlaService(mockSvc);
});

afterEach(() => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe("Auth guard — all DSR routes require admin token", () => {
  const routes = [
    { method: "get",   path: "/api/v1/admin/gdpr/dsr/dashboard" },
    { method: "get",   path: "/api/v1/admin/gdpr/dsr" },
    { method: "get",   path: "/api/v1/admin/gdpr/dsr/dsr-001" },
    { method: "post",  path: "/api/v1/admin/gdpr/dsr" },
    { method: "patch", path: "/api/v1/admin/gdpr/dsr/dsr-001/status" },
    { method: "post",  path: "/api/v1/admin/gdpr/dsr/dsr-001/resolve" },
    { method: "post",  path: "/api/v1/admin/gdpr/dsr/dsr-001/extend" },
    { method: "post",  path: "/api/v1/admin/gdpr/dsr/dsr-001/reopen" },
  ];

  for (const { method, path } of routes) {
    it(`${method.toUpperCase()} ${path} → 401 without token`, async () => {
      const res = await (request(app) as any)[method](path).send({});
      expect(res.status).toBe(401);
    });
  }
});

// ─── GET /dashboard ───────────────────────────────────────────────────────────

describe("GET /api/v1/admin/gdpr/dsr/dashboard", () => {
  it("returns 200 with summary object", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr/dashboard").set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary.total).toBe(5);
    expect(res.body.summary.open).toBe(2);
  });

  it("returns 500 when service throws", async () => {
    mockSvc.getDashboardSummary = async () => { throw new Error("db down"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).get("/api/v1/admin/gdpr/dsr/dashboard").set(ADMIN);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("db down");
  });
});

// ─── GET /gdpr/dsr (list) ────────────────────────────────────────────────────

describe("GET /api/v1/admin/gdpr/dsr", () => {
  it("returns 200 with array of records", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr").set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records[0].id).toBe("dsr-001");
  });

  it("forwards status query param to service", async () => {
    const calls: any[] = [];
    mockSvc.list = async (opts: any) => { calls.push(opts); return [makeRecord()]; };
    setDsrSlaService(mockSvc);
    await request(app).get("/api/v1/admin/gdpr/dsr?status=in_progress").set(ADMIN);
    expect(calls[0].status).toBe("in_progress");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr?status=flying").set(ADMIN);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("returns 400 when limit is 0", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr?limit=0").set(ADMIN);
    expect(res.status).toBe(400);
  });

  it("returns 400 when limit exceeds 200", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr?limit=201").set(ADMIN);
    expect(res.status).toBe(400);
  });

  it("returns 400 when offset is negative", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr?offset=-1").set(ADMIN);
    expect(res.status).toBe(400);
  });

  it("forwards limit and offset to service", async () => {
    const calls: any[] = [];
    mockSvc.list = async (opts: any) => { calls.push(opts); return [makeRecord()]; };
    setDsrSlaService(mockSvc);
    await request(app).get("/api/v1/admin/gdpr/dsr?limit=10&offset=20").set(ADMIN);
    expect(calls[0].limit).toBe(10);
    expect(calls[0].offset).toBe(20);
  });
});

// ─── GET /gdpr/dsr/:id ───────────────────────────────────────────────────────

describe("GET /api/v1/admin/gdpr/dsr/:id", () => {
  it("returns 200 with record and daysRemaining", async () => {
    const res = await request(app).get("/api/v1/admin/gdpr/dsr/dsr-001").set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.record.id).toBe("dsr-001");
    expect(res.body.record.daysRemaining).toBe(30);
  });

  it("returns 404 when service returns null", async () => {
    mockSvc.findById = async () => null;
    setDsrSlaService(mockSvc);
    const res = await request(app).get("/api/v1/admin/gdpr/dsr/unknown").set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

// ─── POST /gdpr/dsr (create) ─────────────────────────────────────────────────

describe("POST /api/v1/admin/gdpr/dsr", () => {
  const validBody = { subjectId: "user-1", subjectEmail: "alice@example.com", requestType: "access" };

  it("returns 201 with the new record", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.record.id).toBe("dsr-001");
  });

  it("returns 400 when subjectId is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
      .send({ subjectEmail: "a@b.com", requestType: "access" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("subjectId");
  });

  it("returns 400 when subjectEmail is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
      .send({ subjectId: "u1", requestType: "access" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("subjectEmail");
  });

  it("returns 400 for invalid requestType", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
      .send({ subjectId: "u1", subjectEmail: "a@b.com", requestType: "delete_everything" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("requestType");
  });

  it("returns 400 for malformed receivedAt", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
      .send({ ...validBody, receivedAt: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("receivedAt");
  });

  it("accepts all six valid requestType values", async () => {
    const types = ["access", "erasure", "rectification", "portability", "restriction", "objection"];
    for (const requestType of types) {
      const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
        .send({ subjectId: "u1", subjectEmail: "a@b.com", requestType });
      expect(res.status).toBe(201);
    }
  });

  it("forwards optional notes to service", async () => {
    const calls: any[] = [];
    mockSvc.create = async (input: any) => { calls.push(input); return makeRecord(); };
    setDsrSlaService(mockSvc);
    await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN)
      .send({ ...validBody, notes: "via postal mail" });
    expect(calls[0].notes).toBe("via postal mail");
  });

  it("returns 500 when service throws", async () => {
    mockSvc.create = async () => { throw new Error("insert failed"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).post("/api/v1/admin/gdpr/dsr").set(ADMIN).send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("insert failed");
  });
});

// ─── PATCH /gdpr/dsr/:id/status ──────────────────────────────────────────────

describe("PATCH /api/v1/admin/gdpr/dsr/:id/status", () => {
  it("returns 200 with updated record", async () => {
    const res = await request(app).patch("/api/v1/admin/gdpr/dsr/dsr-001/status")
      .set(ADMIN).send({ status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.record.status).toBe("in_progress");
  });

  it("returns 400 when status is 'resolved' (use /resolve instead)", async () => {
    const res = await request(app).patch("/api/v1/admin/gdpr/dsr/dsr-001/status")
      .set(ADMIN).send({ status: "resolved" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("status");
  });

  it("returns 400 when status is 'extended' (use /extend instead)", async () => {
    const res = await request(app).patch("/api/v1/admin/gdpr/dsr/dsr-001/status")
      .set(ADMIN).send({ status: "extended" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when service throws not-found error", async () => {
    mockSvc.updateStatus = async () => { throw new Error("DSR not found: dsr-999"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).patch("/api/v1/admin/gdpr/dsr/dsr-999/status")
      .set(ADMIN).send({ status: "in_progress" });
    expect(res.status).toBe(404);
  });
});

// ─── POST /gdpr/dsr/:id/resolve ──────────────────────────────────────────────

describe("POST /api/v1/admin/gdpr/dsr/:id/resolve", () => {
  const validBody = { resolvedBy: "admin-1", resolutionReason: "Data package sent" };

  it("returns 200 with resolved record", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/resolve")
      .set(ADMIN).send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.record.status).toBe("resolved");
  });

  it("returns 400 when resolvedBy is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/resolve")
      .set(ADMIN).send({ resolutionReason: "done" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("resolvedBy");
  });

  it("returns 400 when resolutionReason is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/resolve")
      .set(ADMIN).send({ resolvedBy: "admin-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("resolutionReason");
  });

  it("forwards optional resolutionEvidence to service", async () => {
    const calls: any[] = [];
    mockSvc.resolve = async (_id: string, input: any) => { calls.push(input); return makeRecord({ status: "resolved" }); };
    setDsrSlaService(mockSvc);
    await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/resolve")
      .set(ADMIN).send({ ...validBody, resolutionEvidence: "jira-DSR-42" });
    expect(calls[0].resolutionEvidence).toBe("jira-DSR-42");
  });

  it("returns 404 when service throws terminal-state error", async () => {
    mockSvc.resolve = async () => { throw new Error("DSR not found or already in a terminal state: dsr-001"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/resolve")
      .set(ADMIN).send(validBody);
    expect(res.status).toBe(404);
  });
});

// ─── POST /gdpr/dsr/:id/extend ───────────────────────────────────────────────

describe("POST /api/v1/admin/gdpr/dsr/:id/extend", () => {
  it("returns 200 with extended record", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({ extensionReason: "Highly complex cross-border request" });
    expect(res.status).toBe(200);
    expect(res.body.record.status).toBe("extended");
  });

  it("returns 400 when extensionReason is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("extensionReason");
  });

  it("returns 400 when additionalDays is 0", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({ extensionReason: "complex", additionalDays: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("additionalDays");
  });

  it("returns 400 when additionalDays exceeds 60", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({ extensionReason: "complex", additionalDays: 61 });
    expect(res.status).toBe(400);
  });

  it("forwards valid additionalDays to service", async () => {
    const calls: any[] = [];
    mockSvc.extend = async (_id: string, input: any) => { calls.push(input); return makeRecord({ status: "extended" }); };
    setDsrSlaService(mockSvc);
    await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({ extensionReason: "complex", additionalDays: 30 });
    expect(calls[0].additionalDays).toBe(30);
  });

  it("returns 404 when service throws terminal-state error", async () => {
    mockSvc.extend = async () => { throw new Error("DSR not found or already in a terminal state: dsr-001"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/extend")
      .set(ADMIN).send({ extensionReason: "complex" });
    expect(res.status).toBe(404);
  });
});

// ─── POST /gdpr/dsr/:id/reopen ───────────────────────────────────────────────

describe("POST /api/v1/admin/gdpr/dsr/:id/reopen", () => {
  it("returns 200 with reopened record", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/reopen")
      .set(ADMIN).send({ reason: "Regulatory challenge received" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.record.status).toBe("open");
  });

  it("returns 400 when reason is missing", async () => {
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/reopen")
      .set(ADMIN).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("reason");
  });

  it("forwards reason to service", async () => {
    const calls: any[] = [];
    mockSvc.reopen = async (id: string, reason: string) => { calls.push({ id, reason }); return makeRecord(); };
    setDsrSlaService(mockSvc);
    await request(app).post("/api/v1/admin/gdpr/dsr/dsr-001/reopen")
      .set(ADMIN).send({ reason: "DPA instruction" });
    expect(calls[0].reason).toBe("DPA instruction");
    expect(calls[0].id).toBe("dsr-001");
  });

  it("returns 404 when service throws not-found error", async () => {
    mockSvc.reopen = async () => { throw new Error("DSR not found: missing"); };
    setDsrSlaService(mockSvc);
    const res = await request(app).post("/api/v1/admin/gdpr/dsr/missing/reopen")
      .set(ADMIN).send({ reason: "x" });
    expect(res.status).toBe(404);
  });
});

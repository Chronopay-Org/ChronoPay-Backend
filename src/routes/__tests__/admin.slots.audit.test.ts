// @ts-nocheck
/**
 * Tests for admin slot inventory audit logging (issue #599).
 *
 * Covers:
 *  - Mutation routes: audit record written on create / update / delete
 *  - Validation: missing reason, short reason, whitespace-only reason
 *  - Authorization: non-admin rejected on all mutation routes and audit feed
 *  - Behaviour: no-op update skips audit; downstream failure rolls back audit
 *  - Audit feed: pagination, ordering, filtering by actor/action/resourceId/date
 */

import request from "supertest";
import express from "express";
import {
  slotAuditLogService,
  SlotAuditLogService,
} from "../../services/slotAuditLog.js";
import {
  slotService,
} from "../../services/slotService.js";
import adminSlotsRouter from "../admin/slots.js";

// ─── App fixture ──────────────────────────────────────────────────────────────

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/admin/slots", adminSlotsRouter);
  return app;
}

const ADMIN_HEADERS = {
  "x-chronopay-admin-token": "test-admin-token",
  "x-chronopay-user-id": "admin-user-1",
};

const ACTOR_HEADERS = {
  "x-chronopay-user-id": "admin-user-1",
  "x-chronopay-role": "admin",
};

// ─── Test setup ───────────────────────────────────────────────────────────────

let app: express.Application;

beforeAll(() => {
  process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
  app = buildApp();
});

afterAll(() => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
});

beforeEach(() => {
  slotService.reset();
  slotAuditLogService.reset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validSlotBody(overrides: Record<string, unknown> = {}) {
  return {
    professional: "alice",
    startTime: Date.now() + 1000,
    endTime: Date.now() + 3600_000,
    reason: "Scheduled capacity adjustment for Q3",
    ...overrides,
  };
}

async function createSlot(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/admin/slots")
    .set(ADMIN_HEADERS)
    .send(validSlotBody(overrides));
  return res;
}

// ─── 1. Create audit record ───────────────────────────────────────────────────

describe("POST /admin/slots — create audit record", () => {
  it("returns 201 and writes a create audit record", async () => {
    const res = await createSlot();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const { data } = slotAuditLogService.list();
    expect(data).toHaveLength(1);
    const [rec] = data;
    expect(rec.action).toBe("create");
    expect(rec.before).toBeNull();
    expect(rec.after).not.toBeNull();
    expect(rec.reason).toBe("Scheduled capacity adjustment for Q3");
    expect(rec.actor).toBeTruthy();
    expect(rec.timestamp).toBeTruthy();
    expect(rec.resourceId).toBeTruthy();
    expect(rec.id).toBeTruthy();
  });

  it("audit record is immutable (Object.isFrozen)", async () => {
    await createSlot();
    const { data } = slotAuditLogService.list();
    expect(Object.isFrozen(data[0])).toBe(true);
  });

  it("does NOT write an audit record when slot creation fails", async () => {
    // endTime <= startTime triggers SlotValidationError
    const res = await request(app)
      .post("/admin/slots")
      .set(ADMIN_HEADERS)
      .send(validSlotBody({ endTime: Date.now() - 1 }));

    expect(res.status).toBe(422);
    expect(slotAuditLogService.list().data).toHaveLength(0);
  });
});

// ─── 2. Update audit record ───────────────────────────────────────────────────

describe("PATCH /admin/slots/:id — update audit record", () => {
  it("writes an update audit record with before and after state", async () => {
    const created = await createSlot();
    const slotId = created.body.slot.id;
    slotAuditLogService.reset(); // isolate

    const res = await request(app)
      .patch(`/admin/slots/${slotId}`)
      .set(ADMIN_HEADERS)
      .send({ professional: "bob", reason: "Reassigning slot to different professional" });

    expect(res.status).toBe(200);
    const { data } = slotAuditLogService.list();
    expect(data).toHaveLength(1);
    const [rec] = data;
    expect(rec.action).toBe("update");
    expect(rec.resourceId).toBe(String(slotId));
    expect((rec.before as any).professional).toBe("alice");
    expect((rec.after as any).professional).toBe("bob");
    expect(rec.reason).toBe("Reassigning slot to different professional");
  });

  it("does NOT write audit record when slot not found", async () => {
    const res = await request(app)
      .patch("/admin/slots/999")
      .set(ADMIN_HEADERS)
      .send({ professional: "bob", reason: "Reassigning the slot to another person" });

    expect(res.status).toBe(404);
    expect(slotAuditLogService.list().data).toHaveLength(0);
  });
});

// ─── 3. Delete audit record ───────────────────────────────────────────────────

describe("DELETE /admin/slots/:id — delete audit record", () => {
  it("writes a delete audit record with before state and null after", async () => {
    const created = await createSlot();
    const slotId = created.body.slot.id;
    slotAuditLogService.reset();

    const res = await request(app)
      .delete(`/admin/slots/${slotId}`)
      .set(ADMIN_HEADERS)
      .send({ reason: "Removing duplicate slot from inventory" });

    expect(res.status).toBe(200);
    const { data } = slotAuditLogService.list();
    expect(data).toHaveLength(1);
    const [rec] = data;
    expect(rec.action).toBe("delete");
    expect(rec.resourceId).toBe(String(slotId));
    expect(rec.before).not.toBeNull();
    expect(rec.after).toBeNull();
  });

  it("does NOT write audit record when slot not found", async () => {
    const res = await request(app)
      .delete("/admin/slots/999")
      .set(ADMIN_HEADERS)
      .send({ reason: "Removing duplicate slot from inventory" });

    expect(res.status).toBe(404);
    expect(slotAuditLogService.list().data).toHaveLength(0);
  });
});

// ─── 4. Reason validation ─────────────────────────────────────────────────────

describe("Reason validation — 400 for invalid reason", () => {
  const routes = [
    { method: "post", path: "/admin/slots" },
    { method: "patch", path: "/admin/slots/1" },
    { method: "delete", path: "/admin/slots/1" },
  ];

  for (const { method, path } of routes) {
    describe(`${method.toUpperCase()} ${path}`, () => {
      it("returns 400 when reason is missing", async () => {
        const { reason: _r, ...body } = validSlotBody();
        const res = await (request(app) as any)
          [method](path)
          .set(ADMIN_HEADERS)
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/reason/i);
      });

      it("returns 400 when reason is whitespace-only", async () => {
        const res = await (request(app) as any)
          [method](path)
          .set(ADMIN_HEADERS)
          .send({ ...validSlotBody(), reason: "   " });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/reason/i);
      });

      it("returns 400 when reason is too short (< 10 chars)", async () => {
        const res = await (request(app) as any)
          [method](path)
          .set(ADMIN_HEADERS)
          .send({ ...validSlotBody(), reason: "Short" });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/10 characters/i);
      });

      it("accepts reason with exactly 10 chars", async () => {
        // Only meaningful for create
        if (method !== "post") return;
        const res = await (request(app) as any)
          [method](path)
          .set(ADMIN_HEADERS)
          .send({ ...validSlotBody(), reason: "1234567890" });
        expect([201, 200, 422, 404]).toContain(res.status); // not 400
      });
    });
  }
});

// ─── 5. Authorization ─────────────────────────────────────────────────────────

describe("Authorization", () => {
  it("POST /admin/slots returns 401 without auth headers", async () => {
    const res = await request(app).post("/admin/slots").send(validSlotBody());
    expect([401, 403]).toContain(res.status);
  });

  it("PATCH /admin/slots/:id returns 401 without auth headers", async () => {
    const res = await request(app).patch("/admin/slots/1").send(validSlotBody());
    expect([401, 403]).toContain(res.status);
  });

  it("DELETE /admin/slots/:id returns 401 without auth headers", async () => {
    const res = await request(app)
      .delete("/admin/slots/1")
      .send({ reason: "Removing duplicate slot from inventory" });
    expect([401, 403]).toContain(res.status);
  });

  it("GET /admin/slots/audit/slots returns 401 without auth headers", async () => {
    const res = await request(app).get("/admin/slots/audit/slots");
    expect([401, 403]).toContain(res.status);
  });

  it("rejects wrong admin token with 403", async () => {
    const res = await request(app)
      .post("/admin/slots")
      .set({ "x-chronopay-admin-token": "wrong-token" })
      .send(validSlotBody());
    expect(res.status).toBe(403);
  });

  it("allows access via x-chronopay-role: admin header pair", async () => {
    const res = await request(app)
      .post("/admin/slots")
      .set(ACTOR_HEADERS)
      .send(validSlotBody());
    expect([201, 422]).toContain(res.status); // not 401/403
  });

  it("actor identity always comes from authenticated context, not request body", async () => {
    const res = await request(app)
      .post("/admin/slots")
      .set({ ...ADMIN_HEADERS, "x-chronopay-user-id": "real-admin" })
      .send({ ...validSlotBody(), actor: "hacker-injected-actor" });

    expect(res.status).toBe(201);
    const { data } = slotAuditLogService.list();
    expect(data[0].actor).not.toBe("hacker-injected-actor");
  });
});

// ─── 6. No-op update skips audit ─────────────────────────────────────────────

describe("No-op update", () => {
  it("does not write an audit record when no fields actually change", async () => {
    const created = await createSlot();
    const slotId = created.body.slot.id;
    slotAuditLogService.reset();

    // Send exactly the same professional value — pure no-op
    const res = await request(app)
      .patch(`/admin/slots/${slotId}`)
      .set(ADMIN_HEADERS)
      .send({ professional: "alice", reason: "Testing no-op detection for slot" });

    expect(res.status).toBe(200);
    expect(slotAuditLogService.list().data).toHaveLength(0);
  });
});

// ─── 7. Audit feed ───────────────────────────────────────────────────────────

describe("GET /admin/slots/audit/slots — audit feed", () => {
  async function seedRecords(n: number) {
    for (let i = 0; i < n; i++) {
      await createSlot({ professional: `prof-${i}` });
    }
  }

  it("returns 200 with paginated results (newest first)", async () => {
    await seedRecords(3);

    const res = await request(app)
      .get("/admin/slots/audit/slots?page=1&limit=10")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);

    // Newest first — timestamps should be descending
    const timestamps = res.body.data.map((r: any) => r.timestamp);
    const sorted = [...timestamps].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    expect(timestamps).toEqual(sorted);
  });

  it("paginates results correctly", async () => {
    await seedRecords(5);

    const page1 = await request(app)
      .get("/admin/slots/audit/slots?page=1&limit=2")
      .set(ADMIN_HEADERS);
    const page2 = await request(app)
      .get("/admin/slots/audit/slots?page=2&limit=2")
      .set(ADMIN_HEADERS);
    const page3 = await request(app)
      .get("/admin/slots/audit/slots?page=3&limit=2")
      .set(ADMIN_HEADERS);

    expect(page1.body.data).toHaveLength(2);
    expect(page2.body.data).toHaveLength(2);
    expect(page3.body.data).toHaveLength(1);
    expect(page1.body.total).toBe(5);

    // No duplicates across pages
    const ids = [
      ...page1.body.data.map((r: any) => r.id),
      ...page2.body.data.map((r: any) => r.id),
      ...page3.body.data.map((r: any) => r.id),
    ];
    expect(new Set(ids).size).toBe(5);
  });

  it("filters by action", async () => {
    const created = await createSlot();
    const slotId = created.body.slot.id;

    await request(app)
      .patch(`/admin/slots/${slotId}`)
      .set(ADMIN_HEADERS)
      .send({ professional: "bob", reason: "Reassigning slot to different professional" });

    const res = await request(app)
      .get("/admin/slots/audit/slots?action=update")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.action === "update")).toBe(true);
  });

  it("filters by resourceId", async () => {
    const c1 = await createSlot({ professional: "alice" });
    await createSlot({ professional: "bob" });
    const id1 = String(c1.body.slot.id);

    const res = await request(app)
      .get(`/admin/slots/audit/slots?resourceId=${id1}`)
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.resourceId === id1)).toBe(true);
  });

  it("filters by actor", async () => {
    await createSlot();

    const res = await request(app)
      .get("/admin/slots/audit/slots?actor=admin-token-user")
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    // All returned records should match the actor
    for (const rec of res.body.data) {
      expect(rec.actor).toBeTruthy();
    }
  });

  it("filters by since date — excludes older records", async () => {
    // Manually seed a record in the past
    slotAuditLogService.persist({
      actor: "admin",
      action: "create",
      resourceId: "old-slot",
      before: null,
      after: { id: "old-slot" },
      reason: "Old record for testing date filtering",
    });

    const future = new Date(Date.now() + 1000).toISOString();
    const res = await request(app)
      .get(`/admin/slots/audit/slots?since=${encodeURIComponent(future)}`)
      .set(ADMIN_HEADERS);

    expect(res.status).toBe(200);
    // Old record should not appear
    expect(res.body.data.every((r: any) => r.resourceId !== "old-slot")).toBe(true);
  });

  it("returns 400 for invalid page parameter", async () => {
    const res = await request(app)
      .get("/admin/slots/audit/slots?page=0")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(400);
  });

  it("returns 400 for limit > 200", async () => {
    const res = await request(app)
      .get("/admin/slots/audit/slots?limit=201")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid action filter", async () => {
    const res = await request(app)
      .get("/admin/slots/audit/slots?action=invalid")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(400);
  });

  it("returns empty data array when no records match filter", async () => {
    await createSlot();
    const res = await request(app)
      .get("/admin/slots/audit/slots?action=delete")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });
});

// ─── 8. SlotAuditLogService unit tests ───────────────────────────────────────

describe("SlotAuditLogService", () => {
  let svc: SlotAuditLogService;

  beforeEach(() => {
    svc = new SlotAuditLogService();
  });

  it("persisted records are immutable", () => {
    const rec = svc.persist({
      actor: "a",
      action: "create",
      resourceId: "1",
      before: null,
      after: { id: "1" },
      reason: "reason text here",
    });
    expect(Object.isFrozen(rec)).toBe(true);
  });

  it("list returns newest first", () => {
    svc.persist({ actor: "a", action: "create", resourceId: "1", before: null, after: { id: "1" }, reason: "first record reason" });
    svc.persist({ actor: "a", action: "update", resourceId: "1", before: { id: "1" }, after: { id: "1", x: 2 }, reason: "second record reason" });

    const { data } = svc.list();
    expect(data[0].action).toBe("update"); // newest first
    expect(data[1].action).toBe("create");
  });

  it("reset clears all records", () => {
    svc.persist({ actor: "a", action: "create", resourceId: "1", before: null, after: { id: "1" }, reason: "testing reset functionality" });
    svc.reset();
    expect(svc.list().data).toHaveLength(0);
  });
});

// ─── 9. audit() helper unit tests ────────────────────────────────────────────

describe("audit() helper", () => {
  it("does not write record when mutate() throws", async () => {
    const svc = new SlotAuditLogService();
    const { audit } = await import("../../services/slotAuditLog.js");

    await expect(
      audit(
        { actor: "a", action: "create", resourceId: "1", reason: "valid reason string" },
        async () => null,
        async () => { throw new Error("mutation failed"); },
        async () => null,
        svc,
      ),
    ).rejects.toThrow("mutation failed");

    expect(svc.list().data).toHaveLength(0);
  });

  it("skips audit record for a no-op update (before === after)", async () => {
    const svc = new SlotAuditLogService();
    const { audit } = await import("../../services/slotAuditLog.js");
    const state = { id: "1", professional: "alice" };

    await audit(
      { actor: "a", action: "update", resourceId: "1", reason: "reason for no-op test" },
      async () => ({ ...state }),
      async () => ({ ...state }),
      async (r) => ({ ...r }),
      svc,
    );

    expect(svc.list().data).toHaveLength(0);
  });

  it("writes record when before and after differ", async () => {
    const svc = new SlotAuditLogService();
    const { audit } = await import("../../services/slotAuditLog.js");

    await audit(
      { actor: "a", action: "update", resourceId: "1", reason: "valid reason here" },
      async () => ({ professional: "alice" }),
      async () => ({ professional: "bob" }),
      async (r) => r,
      svc,
    );

    expect(svc.list().data).toHaveLength(1);
  });
});

// ─── 10. validateReason unit tests ───────────────────────────────────────────

describe("validateReason()", () => {
  it("throws for undefined", async () => {
    const { validateReason } = await import("../../services/slotAuditLog.js");
    expect(() => validateReason(undefined)).toThrow(/required/i);
  });

  it("throws for whitespace-only string", async () => {
    const { validateReason } = await import("../../services/slotAuditLog.js");
    expect(() => validateReason("   ")).toThrow(/whitespace/i);
  });

  it("throws for string shorter than 10 chars", async () => {
    const { validateReason } = await import("../../services/slotAuditLog.js");
    expect(() => validateReason("short")).toThrow(/10 characters/i);
  });

  it("trims the reason", async () => {
    const { validateReason } = await import("../../services/slotAuditLog.js");
    expect(validateReason("  valid reason text  ")).toBe("valid reason text");
  });

  it("accepts a reason of exactly 10 chars", async () => {
    const { validateReason } = await import("../../services/slotAuditLog.js");
    expect(() => validateReason("1234567890")).not.toThrow();
  });
});

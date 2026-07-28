/**
 * Tests for the reputation write-audit trail (#457)
 *
 * Covers:
 *  - writeReputationScore: appends events, validates cause, actor, supplier
 *  - listReputationEvents: pagination, time range filters, newest-first order
 *  - HTTP: GET /api/v1/admin/suppliers/:id/reputation/history
 *  - Edge cases: cause_id null guard, backfill (custom occurredAt), unknown cause
 */

import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import adminRouter from "../admin.js";
import {
  writeReputationScore,
  listReputationEvents,
  _resetReputationEventStore,
  REPUTATION_EVENT_CAUSES,
} from "../../services/reputationWriteAudit.js";

const ADMIN_TOKEN = "reputation-audit-test-token";
process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  return app;
}

beforeEach(() => {
  _resetReputationEventStore();
});

// ─── Unit: writeReputationScore ───────────────────────────────────────────────

describe("writeReputationScore()", () => {
  it("appends an event for each allowed cause", async () => {
    for (const cause of REPUTATION_EVENT_CAUSES) {
      await writeReputationScore({
        supplierId: "sup-1",
        actorId: "system",
        cause,
        scoreBefore: 70,
        scoreAfter: cause === "dispute" ? 65 : 72,
      });
    }
    const { events } = await listReputationEvents({ supplierId: "sup-1" });
    expect(events).toHaveLength(REPUTATION_EVENT_CAUSES.length);
  });

  it("computes delta automatically from scoreBefore and scoreAfter", async () => {
    const event = await writeReputationScore({
      supplierId: "sup-1",
      actorId: "system",
      cause: "review",
      scoreBefore: 60,
      scoreAfter: 65,
    });
    expect(event.delta).toBeCloseTo(5);
  });

  it("allows negative delta (score decrease)", async () => {
    const event = await writeReputationScore({
      supplierId: "sup-1",
      actorId: "system",
      cause: "dispute",
      scoreBefore: 80,
      scoreAfter: 72,
    });
    expect(event.delta).toBeCloseTo(-8);
  });

  it("stores cause_id as null when not provided", async () => {
    const event = await writeReputationScore({
      supplierId: "sup-1",
      actorId: "decay-job",
      cause: "decay_tick",
      scoreBefore: 75,
      scoreAfter: 74,
    });
    expect(event.causeId).toBeNull();
  });

  it("stores the provided cause_id", async () => {
    const event = await writeReputationScore({
      supplierId: "sup-1",
      actorId: "dispute-svc",
      cause: "dispute",
      causeId: "dispute-abc-123",
      scoreBefore: 80,
      scoreAfter: 76,
    });
    expect(event.causeId).toBe("dispute-abc-123");
  });

  it("rejects an unknown cause", async () => {
    await expect(
      writeReputationScore({
        supplierId: "sup-1",
        actorId: "system",
        // @ts-expect-error — intentional bad value
        cause: "hack_score",
        scoreBefore: 70,
        scoreAfter: 100,
      }),
    ).rejects.toThrow(/Invalid reputation event cause/);
  });

  it("rejects empty actorId", async () => {
    await expect(
      writeReputationScore({
        supplierId: "sup-1",
        actorId: "  ",
        cause: "review",
        scoreBefore: 70,
        scoreAfter: 72,
      }),
    ).rejects.toThrow(/actorId/);
  });

  it("rejects empty supplierId", async () => {
    await expect(
      writeReputationScore({
        supplierId: "",
        actorId: "system",
        cause: "review",
        scoreBefore: 70,
        scoreAfter: 72,
      }),
    ).rejects.toThrow(/supplierId/);
  });

  it("supports custom occurredAt for backfill", async () => {
    const past = new Date("2025-01-15T00:00:00.000Z");
    const event = await writeReputationScore({
      supplierId: "sup-2",
      actorId: "backfill-job",
      cause: "manual_override",
      scoreBefore: 50,
      scoreAfter: 55,
      occurredAt: past,
    });
    expect(event.occurredAt.toISOString()).toBe(past.toISOString());
  });
});

// ─── Unit: listReputationEvents ───────────────────────────────────────────────

describe("listReputationEvents()", () => {
  beforeEach(async () => {
    // Seed 5 events for sup-1 at different times
    const base = new Date("2025-06-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await writeReputationScore({
        supplierId: "sup-1",
        actorId: "system",
        cause: "decay_tick",
        scoreBefore: 80 - i,
        scoreAfter: 79 - i,
        occurredAt: new Date(base.getTime() + i * 86_400_000),
      });
    }
    // One event for a different supplier
    await writeReputationScore({
      supplierId: "sup-2",
      actorId: "system",
      cause: "review",
      scoreBefore: 60,
      scoreAfter: 62,
    });
  });

  it("returns only events for the requested supplier", async () => {
    const { events, total } = await listReputationEvents({ supplierId: "sup-1" });
    expect(total).toBe(5);
    expect(events.every((e) => e.supplierId === "sup-1")).toBe(true);
  });

  it("returns events newest-first", async () => {
    const { events } = await listReputationEvents({ supplierId: "sup-1" });
    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i].occurredAt.getTime()).toBeGreaterThanOrEqual(
        events[i + 1].occurredAt.getTime(),
      );
    }
  });

  it("respects limit and offset", async () => {
    const page1 = await listReputationEvents({ supplierId: "sup-1", limit: 2, offset: 0 });
    const page2 = await listReputationEvents({ supplierId: "sup-1", limit: 2, offset: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    expect(page1.events[0].id).not.toBe(page2.events[0].id);
    expect(page1.total).toBe(5);
  });

  it("filters by since", async () => {
    const since = new Date("2025-06-03T00:00:00.000Z");
    const { events } = await listReputationEvents({ supplierId: "sup-1", since });
    expect(events.every((e) => e.occurredAt >= since)).toBe(true);
  });

  it("filters by until", async () => {
    const until = new Date("2025-06-02T23:59:59.000Z");
    const { events } = await listReputationEvents({ supplierId: "sup-1", until });
    expect(events.every((e) => e.occurredAt <= until)).toBe(true);
  });

  it("returns empty result for unknown supplier", async () => {
    const { events, total } = await listReputationEvents({ supplierId: "sup-ghost" });
    expect(events).toHaveLength(0);
    expect(total).toBe(0);
  });
});

// ─── HTTP: GET /suppliers/:supplierId/reputation/history ─────────────────────

describe("GET /api/v1/admin/suppliers/:supplierId/reputation/history", () => {
  beforeEach(async () => {
    await writeReputationScore({
      supplierId: "sup-http",
      actorId: "system",
      cause: "no_show",
      scoreBefore: 75,
      scoreAfter: 70,
    });
    await writeReputationScore({
      supplierId: "sup-http",
      actorId: "review-svc",
      cause: "review",
      scoreBefore: 70,
      scoreAfter: 73,
    });
  });

  it("returns 401 without admin token", async () => {
    const res = await request(makeApp()).get(
      "/api/v1/admin/suppliers/sup-http/reputation/history",
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with events array and total", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/suppliers/sup-http/reputation/history")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.total).toBe(2);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it("returns empty list for unknown supplier", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/suppliers/sup-nobody/reputation/history")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.events).toHaveLength(0);
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/suppliers/sup-http/reputation/history?limit=999")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid since date", async () => {
    const res = await request(makeApp())
      .get("/api/v1/admin/suppliers/sup-http/reputation/history?since=not-a-date")
      .set("x-chronopay-admin-token", ADMIN_TOKEN);
    expect(res.status).toBe(400);
  });
});

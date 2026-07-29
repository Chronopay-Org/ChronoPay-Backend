/**
 * Unit tests for DsrSlaService.
 *
 * All database calls are intercepted via an injected mock QueryFn so no
 * real PostgreSQL connection is required.  The mock logger is a no-op to
 * keep test output clean.
 */

import {
  DsrSlaService,
  DSR_SLA_DAYS,
  ALERT_THRESHOLDS,
  type QueryFn,
} from "../dsrSlaService.js";
import type { AuditLogger } from "../auditLogger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SILENT_LOGGER = { log: async () => {} } as unknown as AuditLogger;

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date("2025-06-01T12:00:00Z");
  const dueAt = new Date(now);
  dueAt.setDate(dueAt.getDate() + 30);
  return {
    id: "dsr-001",
    subject_id: "user-1",
    subject_email: "alice@example.com",
    request_type: "access",
    received_at: now.toISOString(),
    due_at: dueAt.toISOString(),
    status: "open",
    extension_reason: null,
    alert_7d_sent: false,
    alert_3d_sent: false,
    alert_1d_sent: false,
    resolved_at: null,
    resolved_by: null,
    resolution_reason: null,
    resolution_evidence: null,
    notes: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function makeQueryFn(rows: unknown[] = [], rowCount = 1): QueryFn {
  return async () => ({ rows, rowCount, command: "", oid: 0, fields: [] } as any);
}

// Spy query fn: records all calls and delegates to inner fn
function makeSpyQueryFn(inner: QueryFn): { queryFn: QueryFn; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  const queryFn: QueryFn = async (text, params) => {
    calls.push({ text, params: params ?? [] });
    return inner(text, params);
  };
  return { queryFn, calls };
}

function makeService(queryFn: QueryFn): DsrSlaService {
  return new DsrSlaService(queryFn, SILENT_LOGGER);
}

// ─── create ──────────────────────────────────────────────────────────────────

describe("DsrSlaService.create", () => {
  it("inserts a new DSR and returns the mapped record", async () => {
    const row = makeRow();
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    const record = await svc.create({
      subjectId: "user-1",
      subjectEmail: "alice@example.com",
      requestType: "access",
    });

    expect(record.id).toBe("dsr-001");
    expect(record.subjectId).toBe("user-1");
    expect(record.requestType).toBe("access");
    expect(record.status).toBe("open");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO dsr_sla");
  });

  it("sets due_at 30 calendar days after received_at", async () => {
    const receivedAt = new Date("2025-01-31T00:00:00Z");
    const expectedDue = new Date("2025-03-02T00:00:00Z"); // Jan 31 + 30d = Mar 2
    const row = makeRow({ received_at: receivedAt.toISOString(), due_at: expectedDue.toISOString() });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.create({ subjectId: "u1", subjectEmail: "u@e.com", requestType: "erasure", receivedAt });

    // The due_at passed to the query should be received_at + 30 days
    const passedDueAt = new Date(calls[0].params![4] as string);
    const diff = passedDueAt.getTime() - receivedAt.getTime();
    expect(diff).toBe(DSR_SLA_DAYS * 24 * 60 * 60 * 1000);
  });

  it("uses current time as received_at when not provided", async () => {
    const before = Date.now();
    const row = makeRow();
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.create({ subjectId: "u1", subjectEmail: "u@e.com", requestType: "portability" });

    const passedReceivedAt = new Date(calls[0].params![3] as string).getTime();
    expect(passedReceivedAt).toBeGreaterThanOrEqual(before);
    expect(passedReceivedAt).toBeLessThanOrEqual(Date.now());
  });

  it("passes optional notes to the query", async () => {
    const row = makeRow({ notes: "via webform" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.create({ subjectId: "u1", subjectEmail: "u@e.com", requestType: "access", notes: "via webform" });

    expect(calls[0].params![5]).toBe("via webform");
  });

  it("sends null for notes when not provided", async () => {
    const row = makeRow();
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.create({ subjectId: "u1", subjectEmail: "u@e.com", requestType: "objection" });
    expect(calls[0].params![5]).toBeNull();
  });
});

// ─── updateStatus ─────────────────────────────────────────────────────────────

describe("DsrSlaService.updateStatus", () => {
  it("updates status and returns the mapped record", async () => {
    const row = makeRow({ status: "in_progress" });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.updateStatus("dsr-001", { status: "in_progress" });
    expect(record.status).toBe("in_progress");
  });

  it("throws when rowCount is 0 (record not found)", async () => {
    const svc = makeService(makeQueryFn([], 0));
    await expect(svc.updateStatus("missing-id", { status: "in_progress" }))
      .rejects.toThrow("DSR not found: missing-id");
  });

  it("passes optional notes to the query", async () => {
    const row = makeRow({ status: "in_progress", notes: "now being handled" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.updateStatus("dsr-001", { status: "in_progress", notes: "now being handled" });
    expect(calls[0].params![2]).toBe("now being handled");
  });
});

// ─── resolve ──────────────────────────────────────────────────────────────────

describe("DsrSlaService.resolve", () => {
  it("sets status to resolved and populates resolution fields", async () => {
    const resolvedAt = new Date();
    const row = makeRow({
      status: "resolved",
      resolved_by: "admin-1",
      resolution_reason: "Data provided",
      resolved_at: resolvedAt.toISOString(),
    });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.resolve("dsr-001", {
      resolvedBy: "admin-1",
      resolutionReason: "Data provided",
    });

    expect(record.status).toBe("resolved");
    expect(record.resolvedBy).toBe("admin-1");
    expect(record.resolutionReason).toBe("Data provided");
  });

  it("stores optional resolutionEvidence", async () => {
    const row = makeRow({ status: "resolved", resolution_evidence: "ticket-123" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.resolve("dsr-001", {
      resolvedBy: "admin-1",
      resolutionReason: "Erasure complete",
      resolutionEvidence: "ticket-123",
    });
    expect(calls[0].params![4]).toBe("ticket-123");
  });

  it("throws when rowCount is 0 (already terminal or not found)", async () => {
    const svc = makeService(makeQueryFn([], 0));
    await expect(
      svc.resolve("dsr-001", { resolvedBy: "admin", resolutionReason: "done" }),
    ).rejects.toThrow("terminal state");
  });
});

// ─── extend ───────────────────────────────────────────────────────────────────

describe("DsrSlaService.extend", () => {
  it("sets status to extended and returns updated record", async () => {
    const row = makeRow({ status: "extended", extension_reason: "complex request" });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.extend("dsr-001", { extensionReason: "complex request" });
    expect(record.status).toBe("extended");
    expect(record.extensionReason).toBe("complex request");
  });

  it("defaults to DSR_SLA_DAYS additional days", async () => {
    const row = makeRow({ status: "extended" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.extend("dsr-001", { extensionReason: "complex" });
    expect(calls[0].params![1]).toBe(DSR_SLA_DAYS);
  });

  it("accepts custom additional days", async () => {
    const row = makeRow({ status: "extended" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.extend("dsr-001", { extensionReason: "very complex", additionalDays: 60 });
    expect(calls[0].params![1]).toBe(60);
  });

  it("throws when rowCount is 0", async () => {
    const svc = makeService(makeQueryFn([], 0));
    await expect(svc.extend("missing", { extensionReason: "x" })).rejects.toThrow("terminal state");
  });
});

// ─── reopen ───────────────────────────────────────────────────────────────────

describe("DsrSlaService.reopen", () => {
  it("resets status to open and clears resolution fields", async () => {
    const now = new Date();
    const newDueAt = new Date(now);
    newDueAt.setDate(newDueAt.getDate() + DSR_SLA_DAYS);
    const row = makeRow({
      status: "open",
      resolved_at: null,
      resolved_by: null,
      resolution_reason: null,
      alert_7d_sent: false,
      alert_3d_sent: false,
      alert_1d_sent: false,
      received_at: now.toISOString(),
      due_at: newDueAt.toISOString(),
    });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.reopen("dsr-001", "Regulatory challenge");
    expect(record.status).toBe("open");
    expect(record.resolvedAt).toBeNull();
    expect(record.alert7dSent).toBe(false);
  });

  it("restarts the SLA clock — new due_at is now + 30 days", async () => {
    const before = Date.now();
    const row = makeRow({ status: "open" });
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
    const svc = makeService(queryFn);

    await svc.reopen("dsr-001", "Reopened by regulator");

    const passedReceivedAt = new Date(calls[0].params![1] as string).getTime();
    const passedDueAt = new Date(calls[0].params![2] as string).getTime();
    expect(passedReceivedAt).toBeGreaterThanOrEqual(before);
    expect(passedDueAt - passedReceivedAt).toBe(DSR_SLA_DAYS * 24 * 60 * 60 * 1000);
  });

  it("throws when record not found", async () => {
    const svc = makeService(makeQueryFn([], 0));
    await expect(svc.reopen("missing", "reason")).rejects.toThrow("DSR not found");
  });
});

// ─── markAlertSent ────────────────────────────────────────────────────────────

describe("DsrSlaService.markAlertSent", () => {
  it.each(ALERT_THRESHOLDS)("issues UPDATE for threshold %d", async (threshold) => {
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.markAlertSent("dsr-001", threshold);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("UPDATE dsr_sla");
    const expectedCol = threshold === 7 ? "alert_7d_sent" : threshold === 3 ? "alert_3d_sent" : "alert_1d_sent";
    expect(calls[0].text).toContain(expectedCol);
    expect(calls[0].params![0]).toBe("dsr-001");
  });
});

// ─── findById ─────────────────────────────────────────────────────────────────

describe("DsrSlaService.findById", () => {
  it("returns a record with daysRemaining computed", async () => {
    const now = new Date("2025-06-20T00:00:00Z");
    const dueAt = new Date("2025-06-25T00:00:00Z"); // 5 days away
    const row = makeRow({ due_at: dueAt.toISOString() });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.findById("dsr-001", now);
    expect(record).not.toBeNull();
    expect(record!.daysRemaining).toBe(5);
  });

  it("returns negative daysRemaining for overdue records", async () => {
    const now = new Date("2025-07-15T00:00:00Z");
    const dueAt = new Date("2025-07-10T00:00:00Z"); // 5 days past due
    const row = makeRow({ due_at: dueAt.toISOString() });
    const svc = makeService(makeQueryFn([row]));

    const record = await svc.findById("dsr-001", now);
    expect(record!.daysRemaining).toBe(-5); // floor(exactly -5 days) = -5
  });

  it("returns null when not found", async () => {
    const svc = makeService(makeQueryFn([]));
    const result = await svc.findById("missing");
    expect(result).toBeNull();
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe("DsrSlaService.list", () => {
  it("returns mapped records with countdown attached", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const dueAt = new Date("2025-06-08T00:00:00Z"); // 7 days away
    const rows = [makeRow({ due_at: dueAt.toISOString() })];
    const svc = makeService(makeQueryFn(rows));

    const records = await svc.list({ now });
    expect(records).toHaveLength(1);
    expect(records[0].daysRemaining).toBe(7);
  });

  it("applies status filter when provided", async () => {
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.list({ status: "open" });
    expect(calls[0].text).toContain("WHERE status IN");
    expect(calls[0].params).toContain("open");
  });

  it("applies no WHERE clause when status is omitted", async () => {
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.list();
    expect(calls[0].text).not.toContain("WHERE");
  });

  it("passes limit and offset to the query", async () => {
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.list({ limit: 10, offset: 20 });
    expect(calls[0].params).toContain(10);
    expect(calls[0].params).toContain(20);
  });

  it("accepts an array of statuses", async () => {
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.list({ status: ["open", "in_progress"] });
    expect(calls[0].params).toContain("open");
    expect(calls[0].params).toContain("in_progress");
  });
});

// ─── findDueSoon ──────────────────────────────────────────────────────────────

describe("DsrSlaService.findDueSoon", () => {
  it("queries using a cutoff of now + windowDays", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.findDueSoon(7, now);

    const cutoff = new Date(calls[0].params![0] as string);
    const expectedCutoff = new Date("2025-06-08T00:00:00Z");
    expect(cutoff.getTime()).toBe(expectedCutoff.getTime());
  });

  it("returns records with countdown attached", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const dueAt = new Date("2025-06-04T00:00:00Z");
    const rows = [makeRow({ due_at: dueAt.toISOString() })];
    const svc = makeService(makeQueryFn(rows));

    const records = await svc.findDueSoon(7, now);
    expect(records[0].daysRemaining).toBe(3);
  });
});

// ─── findPendingAlerts ────────────────────────────────────────────────────────

describe("DsrSlaService.findPendingAlerts", () => {
  it.each(ALERT_THRESHOLDS)(
    "queries the correct alert_Xd_sent column for threshold %d",
    async (threshold) => {
      const now = new Date("2025-06-01T00:00:00Z");
      const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
      const svc = makeService(queryFn);

      await svc.findPendingAlerts(threshold, now);

      const expectedCol =
        threshold === 7 ? "alert_7d_sent" : threshold === 3 ? "alert_3d_sent" : "alert_1d_sent";
      expect(calls[0].text).toContain(expectedCol);
    },
  );

  it("only returns rows where the alert flag is FALSE", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.findPendingAlerts(7, now);
    expect(calls[0].text).toContain("= FALSE");
  });

  it("sets cutoff to now + threshold days", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([]));
    const svc = makeService(queryFn);

    await svc.findPendingAlerts(3, now);

    const cutoff = new Date(calls[0].params![0] as string);
    const expected = new Date("2025-06-04T00:00:00Z");
    expect(cutoff.getTime()).toBe(expected.getTime());
  });

  it("returns records with countdown attached", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const dueAt = new Date("2025-06-02T00:00:00Z"); // 1 day away
    const rows = [makeRow({ due_at: dueAt.toISOString() })];
    const svc = makeService(makeQueryFn(rows));

    const records = await svc.findPendingAlerts(1, now);
    expect(records[0].daysRemaining).toBe(1);
  });
});

// ─── getDashboardSummary ──────────────────────────────────────────────────────

describe("DsrSlaService.getDashboardSummary", () => {
  it("maps aggregate row to DashboardSummary shape", async () => {
    const aggregateRow = {
      total: "12",
      open: "4",
      in_progress: "3",
      resolved: "3",
      extended: "1",
      rejected: "1",
      overdue: "2",
      due_in_7_days: "3",
      due_in_3_days: "1",
      due_in_1_day: "0",
    };
    const svc = makeService(makeQueryFn([aggregateRow]));

    const summary = await svc.getDashboardSummary();

    expect(summary.total).toBe(12);
    expect(summary.open).toBe(4);
    expect(summary.inProgress).toBe(3);
    expect(summary.resolved).toBe(3);
    expect(summary.extended).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.overdue).toBe(2);
    expect(summary.dueIn7Days).toBe(3);
    expect(summary.dueIn3Days).toBe(1);
    expect(summary.dueIn1Day).toBe(0);
  });

  it("returns zero counts when query returns empty row", async () => {
    const svc = makeService(makeQueryFn([]));
    const summary = await svc.getDashboardSummary();

    expect(summary.total).toBe(0);
    expect(summary.overdue).toBe(0);
    expect(summary.dueIn1Day).toBe(0);
  });

  it("passes four timestamp params to enforce cutoffs at 1d/3d/7d/now", async () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([{}]));
    const svc = makeService(queryFn);

    await svc.getDashboardSummary(now);

    // params[0]=now, [1]=+7d, [2]=+3d, [3]=+1d
    expect(calls[0].params).toHaveLength(4);
    const p0 = new Date(calls[0].params![0] as string);
    const p1 = new Date(calls[0].params![1] as string);
    const p2 = new Date(calls[0].params![2] as string);
    const p3 = new Date(calls[0].params![3] as string);
    expect(p0.getTime()).toBe(now.getTime());
    expect((p1.getTime() - now.getTime()) / 86_400_000).toBe(7);
    expect((p2.getTime() - now.getTime()) / 86_400_000).toBe(3);
    expect((p3.getTime() - now.getTime()) / 86_400_000).toBe(1);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("DsrSlaService edge cases", () => {
  describe("weekend / month-boundary rollover", () => {
    it("Jan 31 + 30 days => Mar 2 (non-leap year)", async () => {
      const receivedAt = new Date("2025-01-31T00:00:00Z");
      const row = makeRow();
      const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
      const svc = makeService(queryFn);

      await svc.create({ subjectId: "u", subjectEmail: "u@e.com", requestType: "access", receivedAt });

      const dueAt = new Date(calls[0].params![4] as string);
      expect(dueAt.toISOString().startsWith("2025-03-02")).toBe(true);
    });

    it("Feb 28 + 30 days => Mar 30 (non-leap year)", async () => {
      const receivedAt = new Date("2025-02-28T00:00:00Z");
      const row = makeRow();
      const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
      const svc = makeService(queryFn);

      await svc.create({ subjectId: "u", subjectEmail: "u@e.com", requestType: "erasure", receivedAt });

      const dueAt = new Date(calls[0].params![4] as string);
      expect(dueAt.toISOString().startsWith("2025-03-30")).toBe(true);
    });

    it("Feb 28 + 30 days => Mar 29 in a leap year", async () => {
      const receivedAt = new Date("2024-02-28T00:00:00Z"); // 2024 is a leap year
      const row = makeRow();
      const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
      const svc = makeService(queryFn);

      await svc.create({ subjectId: "u", subjectEmail: "u@e.com", requestType: "erasure", receivedAt });

      const dueAt = new Date(calls[0].params![4] as string);
      expect(dueAt.toISOString().startsWith("2024-03-29")).toBe(true);
    });
  });

  describe("clock skew tolerance", () => {
    it("daysRemaining is computed from the injected now, not system clock", async () => {
      // If the clock were wrong by 2 days this test would still pass because
      // we inject an explicit 'now' to both the row and the method.
      const now = new Date("2025-06-10T00:00:00Z");
      const dueAt = new Date("2025-06-13T00:00:00Z");
      const row = makeRow({ due_at: dueAt.toISOString() });
      const svc = makeService(makeQueryFn([row]));

      const record = await svc.findById("dsr-001", now);
      expect(record!.daysRemaining).toBe(3);
    });
  });

  describe("request reopened", () => {
    it("resets all three alert flags to false so alerts re-fire", async () => {
      const row = makeRow({
        status: "open",
        alert_7d_sent: false,
        alert_3d_sent: false,
        alert_1d_sent: false,
      });
      const { queryFn, calls } = makeSpyQueryFn(makeQueryFn([row]));
      const svc = makeService(queryFn);

      await svc.reopen("dsr-001", "Regulatory challenge");

      // The UPDATE should set all three flags to FALSE
      expect(calls[0].text).toContain("alert_7d_sent       = FALSE");
      expect(calls[0].text).toContain("alert_3d_sent       = FALSE");
      expect(calls[0].text).toContain("alert_1d_sent       = FALSE");
    });
  });
});

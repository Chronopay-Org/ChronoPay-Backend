/**
 * Unit tests for the DSR SLA scheduler worker.
 *
 * No real DB, file system, or live timers are used.
 * All side-effects go through injected fakes.
 */

import {
  runCycle,
  runOnce,
  DsrSlaWorker,
  type DsrAlertPayload,
  type AlertFn,
} from "../dsrSlaWorker.js";
import { ALERT_THRESHOLDS, type DsrRecord } from "../../services/dsrSlaService.js";
import type { AuditLogger } from "../../services/auditLogger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SILENT_LOGGER = { log: () => Promise.resolve() } as unknown as AuditLogger;

function makeRecord(overrides: Partial<DsrRecord> = {}): DsrRecord {
  const now = new Date("2025-06-01T00:00:00Z");
  const dueAt = new Date("2025-06-08T00:00:00Z");
  return {
    id: "dsr-001", subjectId: "user-1", subjectEmail: "alice@example.com",
    requestType: "access", receivedAt: now, dueAt, status: "open",
    extensionReason: null, alert7dSent: false, alert3dSent: false, alert1dSent: false,
    resolvedAt: null, resolvedBy: null, resolutionReason: null, resolutionEvidence: null,
    notes: null, createdAt: now, updatedAt: now, daysRemaining: 7,
    msRemaining: 7 * 24 * 60 * 60 * 1000, ...overrides,
  };
}

function makeMockService(pendingByThreshold: Partial<Record<number, DsrRecord[]>> = {}) {
  const findPendingAlertsCalls: [number, Date][] = [];
  const markAlertSentCalls: [string, number][] = [];

  return {
    findPendingAlerts: async (threshold: number, now: Date) => {
      findPendingAlertsCalls.push([threshold, now]);
      return pendingByThreshold[threshold] ?? [];
    },
    markAlertSent: async (id: string, threshold: number) => {
      markAlertSentCalls.push([id, threshold]);
    },
    _findPendingAlertsCalls: findPendingAlertsCalls,
    _markAlertSentCalls: markAlertSentCalls,
  } as any;
}

// ─── runCycle ─────────────────────────────────────────────────────────────────

describe("runCycle", () => {
  it("returns zero counts when no alerts are pending", async () => {
    const svc = makeMockService();
    const fired: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { fired.push(p); };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.alertsFired).toBe(0);
    expect(result.errors).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it("fires an alert and calls markAlertSent for each pending record", async () => {
    const record = makeRecord({ id: "dsr-7d", daysRemaining: 7 });
    const svc = makeMockService({ 7: [record] });
    const fired: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { fired.push(p); };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.alertsFired).toBe(1);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(fired).toHaveLength(1);
    expect(svc._markAlertSentCalls).toContainEqual(["dsr-7d", 7]);
  });

  it("fires alerts across all three thresholds independently", async () => {
    const svc = makeMockService({
      7: [makeRecord({ id: "dsr-7d" })],
      3: [makeRecord({ id: "dsr-3d" })],
      1: [makeRecord({ id: "dsr-1d" })],
    });
    const fired: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { fired.push(p); };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.alertsFired).toBe(3);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(result.byThreshold[3].fired).toBe(1);
    expect(result.byThreshold[1].fired).toBe(1);
    expect(svc._markAlertSentCalls).toHaveLength(3);
  });

  it("builds the correct alert payload", async () => {
    const dueAt = new Date("2025-06-08T00:00:00Z");
    const record = makeRecord({ id: "dsr-abc", daysRemaining: 7, dueAt });
    const svc = makeMockService({ 7: [record] });
    const payloads: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { payloads.push(p); };

    await runCycle(svc, alertFn, new Date("2025-06-01T00:00:00Z"));

    expect(payloads[0].dsrId).toBe("dsr-abc");
    expect(payloads[0].subjectId).toBe("user-1");
    expect(payloads[0].requestType).toBe("access");
    expect(payloads[0].dueAt).toEqual(dueAt);
    expect(payloads[0].daysRemaining).toBe(7);
    expect(payloads[0].threshold).toBe(7);
  });

  it("does NOT call markAlertSent when alertFn throws", async () => {
    const svc = makeMockService({ 7: [makeRecord({ id: "dsr-err" })] });
    const alertFn: AlertFn = async () => { throw new Error("channel down"); };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.errors).toBe(1);
    expect(result.alertsFired).toBe(0);
    expect(svc._markAlertSentCalls).toHaveLength(0);
  });

  it("continues processing remaining records after one alertFn failure", async () => {
    const records = [
      makeRecord({ id: "dsr-fail" }),
      makeRecord({ id: "dsr-ok" }),
    ];
    const svc = makeMockService({ 7: records });
    let callCount = 0;
    const alertFn: AlertFn = async () => {
      if (callCount++ === 0) throw new Error("first fails");
    };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.alertsFired).toBe(1);
    expect(result.errors).toBe(1);
    expect(svc._markAlertSentCalls).toContainEqual(["dsr-ok", 7]);
    expect(svc._markAlertSentCalls.map((c: any[]) => c[0])).not.toContain("dsr-fail");
  });

  it("counts errors per threshold correctly", async () => {
    const svc = makeMockService({
      7: [makeRecord({ id: "dsr-7a" }), makeRecord({ id: "dsr-7b" })],
      3: [makeRecord({ id: "dsr-3a" })],
    });
    let callCount = 0;
    const alertFn: AlertFn = async () => {
      if (callCount++ === 0) throw new Error("fail");
    };

    const result = await runCycle(svc, alertFn, new Date());

    expect(result.byThreshold[7].errors).toBe(1);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(result.byThreshold[3].fired).toBe(1);
    expect(result.byThreshold[3].errors).toBe(0);
  });

  it("passes the injected 'now' to findPendingAlerts for all thresholds", async () => {
    const now = new Date("2025-06-15T00:00:00Z");
    const svc = makeMockService();
    await runCycle(svc, async () => {}, now);

    for (const threshold of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([threshold, now]);
    }
  });
});

// ─── runOnce ──────────────────────────────────────────────────────────────────

describe("runOnce", () => {
  it("returns a CycleResult with correct shape when one alert fires", async () => {
    const svc = makeMockService({ 1: [makeRecord({ id: "dsr-urgent", daysRemaining: 1 })] });
    const fired: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { fired.push(p); };

    const result = await runOnce({ service: svc, alertFn, logger: SILENT_LOGGER });

    expect(result.alertsFired).toBe(1);
    expect(result.byThreshold[1].fired).toBe(1);
    expect(result.byThreshold[7].fired).toBe(0);
  });

  it("uses injected nowFn for the cycle timestamp", async () => {
    const fixedNow = new Date("2025-06-20T00:00:00Z");
    const svc = makeMockService();
    await runOnce({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, now: () => fixedNow });

    for (const threshold of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([threshold, fixedNow]);
    }
  });
});

// ─── DsrSlaWorker lifecycle ───────────────────────────────────────────────────

describe("DsrSlaWorker", () => {
  it("isRunning is false before start()", () => {
    const worker = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    expect(worker.isRunning).toBe(false);
  });

  it("isRunning is true after start()", () => {
    const worker = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    worker.start();
    expect(worker.isRunning).toBe(true);
    worker.stop();
  });

  it("isRunning is false after stop()", () => {
    const worker = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    worker.start();
    worker.stop();
    expect(worker.isRunning).toBe(false);
  });

  it("calling start() twice is idempotent — isRunning stays true", () => {
    const worker = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    worker.start();
    worker.start();
    expect(worker.isRunning).toBe(true);
    worker.stop();
  });

  it("fires a cycle after the configured intervalMs", async () => {
    const svc = makeMockService({ 7: [makeRecord()] });
    const fired: DsrAlertPayload[] = [];
    const alertFn: AlertFn = async (p) => { fired.push(p); };
    const worker = new DsrSlaWorker({ service: svc, alertFn, logger: SILENT_LOGGER, intervalMs: 20 });

    worker.start();
    // Wait longer than one interval for the tick to fire
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    worker.stop();

    expect(svc._findPendingAlertsCalls.length).toBeGreaterThan(0);
  });

  it("stops firing after stop() is called", async () => {
    const svc = makeMockService();
    const worker = new DsrSlaWorker({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 5000 });

    worker.start();
    worker.stop();
    // Give async tick a chance to run if stop() didn't work
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(svc._findPendingAlertsCalls).toHaveLength(0);
  });

  it("uses injected nowFn for cycle timestamp", async () => {
    const fixedNow = new Date("2025-07-04T00:00:00Z");
    const svc = makeMockService();
    const worker = new DsrSlaWorker({
      service: svc,
      alertFn: async () => {},
      logger: SILENT_LOGGER,
      intervalMs: 20,
      now: () => fixedNow,
    });

    worker.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    worker.stop();

    for (const threshold of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([threshold, fixedNow]);
    }
  });
});

// ─── runCycle ─────────────────────────────────────────────────────────────────

describe("runCycle", () => {
  it("returns zero counts when no alerts are pending", async () => {
    const svc = makeMockService();
    const fired: DsrAlertPayload[] = [];
    const result = await runCycle(svc, async (p) => { fired.push(p); }, new Date());
    expect(result.alertsFired).toBe(0);
    expect(result.errors).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it("fires alert and calls markAlertSent for a pending record", async () => {
    const svc = makeMockService({ 7: [makeRecord({ id: "dsr-7d" })] });
    const fired: DsrAlertPayload[] = [];
    const result = await runCycle(svc, async (p) => { fired.push(p); }, new Date());
    expect(result.alertsFired).toBe(1);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(fired).toHaveLength(1);
    expect(svc._markAlertSentCalls).toContainEqual(["dsr-7d", 7]);
  });

  it("fires alerts across all three thresholds independently", async () => {
    const svc = makeMockService({
      7: [makeRecord({ id: "dsr-7d" })],
      3: [makeRecord({ id: "dsr-3d" })],
      1: [makeRecord({ id: "dsr-1d" })],
    });
    const result = await runCycle(svc, async () => {}, new Date());
    expect(result.alertsFired).toBe(3);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(result.byThreshold[3].fired).toBe(1);
    expect(result.byThreshold[1].fired).toBe(1);
    expect(svc._markAlertSentCalls).toHaveLength(3);
  });

  it("builds the correct alert payload", async () => {
    const dueAt = new Date("2025-06-08T00:00:00Z");
    const svc = makeMockService({ 7: [makeRecord({ id: "dsr-abc", daysRemaining: 7, dueAt })] });
    const payloads: DsrAlertPayload[] = [];
    await runCycle(svc, async (p) => { payloads.push(p); }, new Date("2025-06-01T00:00:00Z"));
    expect(payloads[0]).toMatchObject({ dsrId: "dsr-abc", subjectId: "user-1", requestType: "access", dueAt, daysRemaining: 7, threshold: 7 });
  });

  it("does NOT call markAlertSent when alertFn throws", async () => {
    const svc = makeMockService({ 7: [makeRecord({ id: "dsr-err" })] });
    const alertFn: AlertFn = async () => { throw new Error("channel down"); };
    const result = await runCycle(svc, alertFn, new Date());
    expect(result.errors).toBe(1);
    expect(result.alertsFired).toBe(0);
    expect(svc._markAlertSentCalls).toHaveLength(0);
  });

  it("continues processing remaining records after one failure", async () => {
    const svc = makeMockService({ 7: [makeRecord({ id: "dsr-fail" }), makeRecord({ id: "dsr-ok" })] });
    let calls = 0;
    const alertFn: AlertFn = async () => { if (calls++ === 0) throw new Error("first fails"); };
    const result = await runCycle(svc, alertFn, new Date());
    expect(result.alertsFired).toBe(1);
    expect(result.errors).toBe(1);
    expect(svc._markAlertSentCalls.map((c: any[]) => c[0])).toContain("dsr-ok");
    expect(svc._markAlertSentCalls.map((c: any[]) => c[0])).not.toContain("dsr-fail");
  });

  it("counts errors per threshold correctly", async () => {
    const svc = makeMockService({
      7: [makeRecord({ id: "dsr-7a" }), makeRecord({ id: "dsr-7b" })],
      3: [makeRecord({ id: "dsr-3a" })],
    });
    let calls = 0;
    const alertFn: AlertFn = async () => { if (calls++ === 0) throw new Error("fail"); };
    const result = await runCycle(svc, alertFn, new Date());
    expect(result.byThreshold[7].errors).toBe(1);
    expect(result.byThreshold[7].fired).toBe(1);
    expect(result.byThreshold[3].fired).toBe(1);
    expect(result.byThreshold[3].errors).toBe(0);
  });

  it("passes the injected now to findPendingAlerts for all thresholds", async () => {
    const now = new Date("2025-06-15T00:00:00Z");
    const svc = makeMockService();
    await runCycle(svc, async () => {}, now);
    for (const t of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([t, now]);
    }
  });
});

// ─── runOnce ──────────────────────────────────────────────────────────────────

describe("runOnce", () => {
  it("fires one alert and returns correct CycleResult", async () => {
    const svc = makeMockService({ 1: [makeRecord({ id: "dsr-urgent", daysRemaining: 1 })] });
    const fired: DsrAlertPayload[] = [];
    const result = await runOnce({ service: svc, alertFn: async (p) => { fired.push(p); }, logger: SILENT_LOGGER });
    expect(result.alertsFired).toBe(1);
    expect(result.byThreshold[1].fired).toBe(1);
    expect(result.byThreshold[7].fired).toBe(0);
  });

  it("uses injected nowFn for the cycle timestamp", async () => {
    const fixedNow = new Date("2025-06-20T00:00:00Z");
    const svc = makeMockService();
    await runOnce({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, now: () => fixedNow });
    for (const t of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([t, fixedNow]);
    }
  });
});

// ─── DsrSlaWorker lifecycle ───────────────────────────────────────────────────

describe("DsrSlaWorker", () => {
  it("isRunning is false before start()", () => {
    const w = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER });
    expect(w.isRunning).toBe(false);
  });

  it("isRunning is true after start()", () => {
    const w = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    w.start();
    expect(w.isRunning).toBe(true);
    w.stop();
  });

  it("isRunning is false after stop()", () => {
    const w = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    w.start();
    w.stop();
    expect(w.isRunning).toBe(false);
  });

  it("calling start() twice is idempotent", () => {
    const w = new DsrSlaWorker({ service: makeMockService(), alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 60_000 });
    w.start();
    w.start();
    expect(w.isRunning).toBe(true);
    w.stop();
  });

  it("fires a cycle after intervalMs elapses", async () => {
    const svc = makeMockService({ 7: [makeRecord()] });
    const w = new DsrSlaWorker({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 15 });
    w.start();
    await new Promise<void>((res) => setTimeout(res, 60));
    w.stop();
    expect(svc._findPendingAlertsCalls.length).toBeGreaterThan(0);
  });

  it("does not fire after stop()", async () => {
    const svc = makeMockService();
    const w = new DsrSlaWorker({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 5000 });
    w.start();
    w.stop();
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(svc._findPendingAlertsCalls).toHaveLength(0);
  });

  it("uses injected nowFn when ticking", async () => {
    const fixedNow = new Date("2025-07-04T00:00:00Z");
    const svc = makeMockService();
    const w = new DsrSlaWorker({ service: svc, alertFn: async () => {}, logger: SILENT_LOGGER, intervalMs: 15, now: () => fixedNow });
    w.start();
    await new Promise<void>((res) => setTimeout(res, 60));
    w.stop();
    for (const t of ALERT_THRESHOLDS) {
      expect(svc._findPendingAlertsCalls).toContainEqual([t, fixedNow]);
    }
  });
});

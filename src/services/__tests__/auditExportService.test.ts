import fs from "fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AuditLogger } from "../../services/auditLogger.js";
import { AuditExportService } from "../../services/auditExportService.js";
import { InMemoryEphemeralStore } from "../../services/ephemeralStore.js";
import { JobQueue } from "../../services/jobQueue.js";
import {
  EpsilonBudgetTracker,
  InMemoryBudgetStore,
  BudgetExhaustedError,
} from "../../services/epsilonBudgetTracker.js";

const EXAMPLE_EVENT = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  eventId: "00000000-0000-4000-8000-000000000000",
  action: "test.event",
  actorIp: "127.0.0.1",
  resource: "/api/test",
  status: 200,
  data: {
    method: "POST",
    body: { message: "hello" },
    context: { userId: "user-1" },
  },
  service: "chronopay-backend",
  environment: "test",
};

function makeToken(exportId: string, expiresAt: number, secret: string): string {
  const payload = `${exportId}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the last NDJSON line of an export as the analytics summary. */
function parseAnalyticsSummary(content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

/** Make a tracker with a large budget so existing tests are not affected. */
function makeLargeBudgetTracker(): EpsilonBudgetTracker {
  return new EpsilonBudgetTracker(
    new InMemoryBudgetStore(),
    () => {}, // silent alarm sink
    { audit_events: 1_000_000 },
  );
}

// ---------------------------------------------------------------------------
// Original tests (unchanged)
// ---------------------------------------------------------------------------

describe("AuditExportService", () => {
  let tempDir: string;
  let logger: AuditLogger;
  let service: AuditExportService;

  beforeEach(async () => {
    process.env.CHRONOPAY_AUDIT_EXPORT_SECRET = "audit-secret";
    // Use a large budget so DP noise doesn't interfere with pre-existing tests.
    process.env.CHRONOPAY_DP_EPSILON = "1";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chronopay-audit-export-"));
    const auditLogFile = path.join(tempDir, "audit.log");
    logger = new AuditLogger({ filePath: auditLogFile, environment: "test" });
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    service = new AuditExportService(
      new InMemoryEphemeralStore(),
      new JobQueue(),
      logger,
      makeLargeBudgetTracker(),
    );
  });

  afterEach(async () => {
    delete process.env.CHRONOPAY_AUDIT_EXPORT_SECRET;
    delete process.env.CHRONOPAY_AUDIT_EXPORT_TTL_SECONDS;
    delete process.env.CHRONOPAY_DP_EPSILON;
    delete process.env.CHRONOPAY_DP_ENABLED;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates a signed export and returns a short-lived download URL with integrity hash", async () => {
    const result = await service.createExport("https://example.com");

    expect(result.downloadUrl).toContain("https://example.com/api/v1/admin/audit/export/download?token=");
    expect(result.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns the same content hash on download and preserves file payload", async () => {
    const { downloadUrl, integrity } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token");
    expect(token).toBeTruthy();

    const exportEntry = await service.getExport(token!);
    expect(exportEntry.integrity).toBe(integrity);
    expect(exportEntry.content).toContain("test.event");
    expect(exportEntry.content).toContain("hello");
  });

  it("fails integrity validation when stored export content is tampered", async () => {
    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const exportId = Buffer.from(token, "base64url").toString("utf8").split(":")[0];
    const store = (service as any).store as InMemoryEphemeralStore<any>;
    const entry = await store.get(exportId);
    expect(entry).toBeDefined();
    entry.content = entry.content.replace("hello", "tampered");
    await store.set(exportId, entry, 300);

    await expect(service.getExport(token)).rejects.toThrow("Export integrity validation failed");
  });

  it("rejects an expired signed token", async () => {
    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const [exportId] = Buffer.from(token, "base64url").toString("utf8").split(":");
    const expiredToken = makeToken(exportId, Date.now() - 1000, process.env.CHRONOPAY_AUDIT_EXPORT_SECRET!);

    await expect(service.getExport(expiredToken)).rejects.toThrow("Export token expired");
  });

  it("rejects a malformed token", async () => {
    await expect(service.getExport("not-a-valid-token")).rejects.toThrow("Invalid export token");
  });
});

// ---------------------------------------------------------------------------
// Differential-privacy analytics summary tests
// ---------------------------------------------------------------------------

describe("AuditExportService — DP analytics summary", () => {
  let tempDir: string;
  let logger: AuditLogger;

  /** Create a service with an isolated large-budget tracker and DP enabled. */
  function makeService(auditLogFile: string, budgetOverrides?: Record<string, number>): AuditExportService {
    const tracker = new EpsilonBudgetTracker(
      new InMemoryBudgetStore(),
      () => {},
      budgetOverrides ?? { audit_events: 1_000_000 },
    );
    return new AuditExportService(
      new InMemoryEphemeralStore(),
      new JobQueue(),
      new AuditLogger({ filePath: auditLogFile, environment: "test" }),
      tracker,
    );
  }

  beforeEach(async () => {
    process.env.CHRONOPAY_AUDIT_EXPORT_SECRET = "audit-secret";
    process.env.CHRONOPAY_DP_EPSILON = "1";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chronopay-dp-test-"));
  });

  afterEach(async () => {
    delete process.env.CHRONOPAY_AUDIT_EXPORT_SECRET;
    delete process.env.CHRONOPAY_DP_EPSILON;
    delete process.env.CHRONOPAY_DP_ENABLED;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Summary structure
  // -------------------------------------------------------------------------

  it("appends an analytics_summary as the last NDJSON line", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    expect(summary["_type"]).toBe("analytics_summary");
  });

  it("summary contains totalEvents, countsByAction, countsByService, and differentialPrivacy fields", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    expect(typeof summary["totalEvents"]).toBe("number");
    expect(typeof summary["countsByAction"]).toBe("object");
    expect(typeof summary["countsByService"]).toBe("object");
    expect(typeof summary["differentialPrivacy"]).toBe("object");
  });

  it("differentialPrivacy metadata has mechanism=laplace and correct epsilon", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    process.env.CHRONOPAY_DP_EPSILON = "0.5";
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    const dp = summary["differentialPrivacy"] as Record<string, unknown>;
    expect(dp["mechanism"]).toBe("laplace");
    expect(dp["epsilon"]).toBe(0.5);
    expect(dp["sensitivity"]).toBe(1);
    expect(typeof dp["noiseScale"]).toBe("number");
    expect(typeof dp["appliedAt"]).toBe("string");
  });

  it("noised counts are non-negative integers", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    // Write several events
    const lines = [EXAMPLE_EVENT, { ...EXAMPLE_EVENT, action: "another.event" }, EXAMPLE_EVENT]
      .map((e) => JSON.stringify(e))
      .join("\n");
    await fs.writeFile(auditLogFile, lines + "\n", "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    const totalEvents = summary["totalEvents"] as number;
    expect(Number.isInteger(totalEvents)).toBe(true);
    expect(totalEvents).toBeGreaterThanOrEqual(0);

    const byAction = summary["countsByAction"] as Record<string, number>;
    for (const count of Object.values(byAction)) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }

    const byService = summary["countsByService"] as Record<string, number>;
    for (const count of Object.values(byService)) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // Edge case: empty log file
  // -------------------------------------------------------------------------

  it("produces a valid summary with zero counts for an empty log", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, "", "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    expect(summary["_type"]).toBe("analytics_summary");
    expect(summary["totalEvents"]).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Edge case: single-event log (small-count bin)
  // -------------------------------------------------------------------------

  it("handles a single-event log (small-count bin) without throwing", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    await expect(service.createExport("https://example.com")).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Edge case: all events have the same action (zero-variance data)
  // -------------------------------------------------------------------------

  it("handles zero-variance data (all events share the same action)", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    const lines = Array.from({ length: 20 }, () => JSON.stringify(EXAMPLE_EVENT)).join("\n");
    await fs.writeFile(auditLogFile, lines + "\n", "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    expect(summary["_type"]).toBe("analytics_summary");
    // Single action bucket — noised count must still be non-negative
    const byAction = summary["countsByAction"] as Record<string, number>;
    for (const v of Object.values(byAction)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // DP disabled mode
  // -------------------------------------------------------------------------

  it("when DP is disabled, summary carries dpDisabled=true and exact counts", async () => {
    process.env.CHRONOPAY_DP_ENABLED = "false";
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const summary = parseAnalyticsSummary(content);
    expect(summary["dpDisabled"]).toBe(true);
    // Exact count — one event with action "test.event"
    const byAction = summary["countsByAction"] as Record<string, number>;
    expect(byAction["test.event"]).toBe(1);
    expect(summary["totalEvents"]).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Epsilon budget exhaustion
  // -------------------------------------------------------------------------

  it("blocks export when epsilon budget is exhausted", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    // Budget of exactly 1.0 — first export consumes it, second should fail.
    process.env.CHRONOPAY_DP_EPSILON = "1";
    const service = makeService(auditLogFile, { audit_events: 1.0 });

    await service.createExport("https://example.com"); // consumes 1.0 — OK
    await expect(service.createExport("https://example.com")).rejects.toThrow(BudgetExhaustedError);
  });

  it("budget tracker accumulates epsilon across multiple exports", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    process.env.CHRONOPAY_DP_EPSILON = "1";
    const tracker = new EpsilonBudgetTracker(
      new InMemoryBudgetStore(),
      () => {},
      { audit_events: 5 },
    );
    const service = new AuditExportService(
      new InMemoryEphemeralStore(),
      new JobQueue(),
      new AuditLogger({ filePath: auditLogFile, environment: "test" }),
      tracker,
    );

    await service.createExport("https://example.com"); // 1.0 spent
    await service.createExport("https://example.com"); // 2.0 spent
    await service.createExport("https://example.com"); // 3.0 spent

    const remaining = await tracker.remainingBudget("audit_events");
    expect(remaining).toBeCloseTo(2.0);
  });

  it("budget alarm fires (warning) when crossing 80% threshold across exports", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    process.env.CHRONOPAY_DP_EPSILON = "1";

    const alarms: Array<{ level: string }> = [];
    const tracker = new EpsilonBudgetTracker(
      new InMemoryBudgetStore(),
      (e) => alarms.push({ level: e.level }),
      { audit_events: 10 }, // budget=10, epsilon=1 → warning fires at 9th export
    );
    const service = new AuditExportService(
      new InMemoryEphemeralStore(),
      new JobQueue(),
      new AuditLogger({ filePath: auditLogFile, environment: "test" }),
      tracker,
    );

    // Make 9 exports → 9.0 spent out of 10.0 (90% → warning fires)
    for (let i = 0; i < 9; i++) {
      await service.createExport("https://example.com");
    }

    expect(alarms.some((a) => a.level === "warning" || a.level === "exhausted")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Raw events are still present alongside the summary
  // -------------------------------------------------------------------------

  it("raw redacted event lines are still present before the summary line", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const { content } = await service.getExport(token);

    const lines = content.split(/\r?\n/).filter(Boolean);
    // At least 2 lines: 1 event line + 1 summary line
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // First line should be a regular audit event, not the summary
    const firstLine = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(firstLine["_type"]).toBeUndefined();
    expect(firstLine["action"]).toBe("test.event");
  });

  it("export content integrity is re-verified correctly after summary is appended", async () => {
    const auditLogFile = path.join(tempDir, "audit.log");
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    const service = makeService(auditLogFile);

    const { downloadUrl, integrity } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const exportEntry = await service.getExport(token);

    // Integrity hash must match content including the summary line
    const crypto = await import("node:crypto");
    const recomputed = crypto.createHash("sha256").update(exportEntry.content, "utf8").digest("hex");
    expect(recomputed).toBe(integrity);
  });
});

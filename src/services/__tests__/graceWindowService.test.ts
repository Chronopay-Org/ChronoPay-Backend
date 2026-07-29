/**
 * graceWindowService.test.ts
 * --------------------------
 * Comprehensive unit-test suite for GraceWindowService.
 *
 * Coverage targets (≥ 95 %):
 *   - resolve()  — default fallback + category-specific override
 *   - get()      — returns config or undefined
 *   - list()     — returns all configured categories
 *   - set()      — happy path, validation errors, history, audit
 *   - delete()   — happy path, not-found, history, audit
 *   - getHistory() — per-category + all-categories, ordering
 *   - validateSetInput — all error branches
 *   - InMemoryGraceWindowStore — direct coverage
 *   - Singleton lifecycle
 */

import {
  GraceWindowService,
  GraceWindowValidationError,
  InMemoryGraceWindowStore,
  DEFAULT_GRACE_WINDOW_SECONDS,
  MIN_GRACE_WINDOW_SECONDS,
  MAX_GRACE_WINDOW_SECONDS,
  validateSetInput,
  getGraceWindowService,
  resetGraceWindowServiceSingleton,
  type GraceWindowConfig,
  type GraceWindowHistoryEntry,
  type SetGraceWindowInput,
} from "../graceWindowService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeService(overrides: { nowIso?: () => string } = {}): {
  service: GraceWindowService;
  store: InMemoryGraceWindowStore;
  auditEvents: { action: string; data: any }[];
} {
  const store = new InMemoryGraceWindowStore();
  const auditEvents: { action: string; data: any }[] = [];

  const mockAuditLogger = {
    log: async (action: string, data: any) => {
      auditEvents.push({ action, data });
    },
  } as any;

  const service = new GraceWindowService({
    store,
    nowIso: overrides.nowIso ?? (() => "2026-07-28T12:00:00.000Z"),
    auditLogger: mockAuditLogger,
    generateId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });

  return { service, store, auditEvents };
}

// ─── resolve() ────────────────────────────────────────────────────────────────

describe("GraceWindowService.resolve()", () => {
  it("returns DEFAULT_GRACE_WINDOW_SECONDS when no config exists", () => {
    const { service } = makeService();
    expect(service.resolve("medical")).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns DEFAULT when category is null", () => {
    const { service } = makeService();
    expect(service.resolve(null)).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns DEFAULT when category is undefined", () => {
    const { service } = makeService();
    expect(service.resolve(undefined)).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns DEFAULT when category is empty string (via store miss)", () => {
    const { service } = makeService();
    // Empty string is falsy — falls back to default.
    expect(service.resolve("")).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns configured value when category has an override", async () => {
    const { service } = makeService();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "admin-1" });
    expect(service.resolve("fitness")).toBe(300);
  });

  it("does not bleed across categories", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "admin-1" });
    expect(service.resolve("beauty")).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("returns updated value after a second set() call", async () => {
    const { service } = makeService();
    await service.set({ category: "legal", graceWindowSeconds: 1800, changedBy: "admin-1" });
    await service.set({ category: "legal", graceWindowSeconds: 2700, changedBy: "admin-2" });
    expect(service.resolve("legal")).toBe(2700);
  });

  it("DEFAULT_GRACE_WINDOW_SECONDS is 900", () => {
    expect(DEFAULT_GRACE_WINDOW_SECONDS).toBe(900);
  });
});

// ─── get() ────────────────────────────────────────────────────────────────────

describe("GraceWindowService.get()", () => {
  it("returns undefined when category has no config", () => {
    const { service } = makeService();
    expect(service.get("fitness")).toBeUndefined();
  });

  it("returns the config after set()", async () => {
    const { service } = makeService();
    await service.set({ category: "beauty", graceWindowSeconds: 120, changedBy: "admin" });
    const cfg = service.get("beauty");
    expect(cfg).toBeDefined();
    expect(cfg!.graceWindowSeconds).toBe(120);
    expect(cfg!.category).toBe("beauty");
    expect(cfg!.updatedBy).toBe("admin");
    expect(cfg!.updatedAt).toBe("2026-07-28T12:00:00.000Z");
  });

  it("returns a copy (mutation-safe)", async () => {
    const { service } = makeService();
    await service.set({ category: "tutoring", graceWindowSeconds: 300, changedBy: "a" });
    const cfg = service.get("tutoring")!;
    cfg.graceWindowSeconds = 9999;
    expect(service.get("tutoring")!.graceWindowSeconds).toBe(300);
  });
});

// ─── list() ───────────────────────────────────────────────────────────────────

describe("GraceWindowService.list()", () => {
  it("returns empty array when nothing is configured", () => {
    const { service } = makeService();
    expect(service.list()).toEqual([]);
  });

  it("returns all configured categories", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });
    const configs = service.list();
    expect(configs).toHaveLength(2);
    const categories = configs.map((c) => c.category).sort();
    expect(categories).toEqual(["fitness", "medical"]);
  });

  it("reflects updates", async () => {
    const { service } = makeService();
    await service.set({ category: "beauty", graceWindowSeconds: 180, changedBy: "a" });
    await service.set({ category: "beauty", graceWindowSeconds: 360, changedBy: "b" });
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]!.graceWindowSeconds).toBe(360);
  });
});

// ─── set() happy path ─────────────────────────────────────────────────────────

describe("GraceWindowService.set() — happy path", () => {
  it("returns the saved config", async () => {
    const { service } = makeService();
    const cfg = await service.set({
      category: "medical",
      graceWindowSeconds: 600,
      changedBy: "admin-1",
    });
    expect(cfg.category).toBe("medical");
    expect(cfg.graceWindowSeconds).toBe(600);
    expect(cfg.updatedBy).toBe("admin-1");
    expect(cfg.updatedAt).toBe("2026-07-28T12:00:00.000Z");
  });

  it("saves reason in history entry", async () => {
    const { service } = makeService();
    await service.set({
      category: "legal",
      graceWindowSeconds: 1200,
      changedBy: "admin",
      reason: "Contract requires 20 min window",
    });
    const history = service.getHistory("legal");
    expect(history[0]!.reason).toBe("Contract requires 20 min window");
  });

  it("sets previousGraceWindowSeconds to null on first write", async () => {
    const { service } = makeService();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });
    const history = service.getHistory("fitness");
    expect(history[0]!.previousGraceWindowSeconds).toBeNull();
    expect(history[0]!.newGraceWindowSeconds).toBe(300);
  });

  it("sets previousGraceWindowSeconds correctly on update", async () => {
    const { service } = makeService();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 600, changedBy: "b" });
    const history = service.getHistory("fitness");
    // Most-recent first.
    expect(history[0]!.newGraceWindowSeconds).toBe(600);
    expect(history[0]!.previousGraceWindowSeconds).toBe(300);
  });

  it("accepts the minimum allowed value", async () => {
    const { service } = makeService();
    const cfg = await service.set({
      category: "other",
      graceWindowSeconds: MIN_GRACE_WINDOW_SECONDS,
      changedBy: "a",
    });
    expect(cfg.graceWindowSeconds).toBe(MIN_GRACE_WINDOW_SECONDS);
  });

  it("accepts the maximum allowed value", async () => {
    const { service } = makeService();
    const cfg = await service.set({
      category: "other",
      graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS,
      changedBy: "a",
    });
    expect(cfg.graceWindowSeconds).toBe(MAX_GRACE_WINDOW_SECONDS);
  });

  it("emits an audit event", async () => {
    const { service, auditEvents } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "admin-1" });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe("grace_window.config_changed");
    expect(auditEvents[0]!.data.context.category).toBe("medical");
    expect(auditEvents[0]!.data.context.newGraceWindowSeconds).toBe(600);
    expect(auditEvents[0]!.data.context.changedBy).toBe("admin-1");
  });

  it("does not throw even if audit logger throws", async () => {
    const store = new InMemoryGraceWindowStore();
    const throwingAudit = { log: async () => { throw new Error("audit offline"); } } as any;
    const service = new GraceWindowService({ store, auditLogger: throwingAudit });
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" }),
    ).resolves.toBeDefined();
  });

  it("generates a unique ID for each history entry", async () => {
    const { service, store } = makeService();
    await service.set({ category: "beauty", graceWindowSeconds: 120, changedBy: "a" });
    await service.set({ category: "beauty", graceWindowSeconds: 240, changedBy: "b" });
    const history = store.getHistory("beauty");
    const ids = history.map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
  });
});

// ─── set() validation errors ──────────────────────────────────────────────────

describe("GraceWindowService.set() — validation", () => {
  it("throws on empty category", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "", graceWindowSeconds: 300, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on category > 100 chars", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "a".repeat(101), graceWindowSeconds: 300, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on non-finite graceWindowSeconds", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: Infinity, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on NaN graceWindowSeconds", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: NaN, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on fractional graceWindowSeconds", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: 300.5, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on graceWindowSeconds < MIN", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: 0, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on graceWindowSeconds > MAX", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS + 1, changedBy: "a" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws on empty changedBy", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "" }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws when reason is a non-string type", async () => {
    const { service } = makeService();
    await expect(
      service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a", reason: 42 as any }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("throws when reason exceeds 500 characters", async () => {
    const { service } = makeService();
    await expect(
      service.set({
        category: "fitness",
        graceWindowSeconds: 300,
        changedBy: "a",
        reason: "x".repeat(501),
      }),
    ).rejects.toThrow(GraceWindowValidationError);
  });

  it("accepts reason of exactly 500 characters", async () => {
    const { service } = makeService();
    await expect(
      service.set({
        category: "fitness",
        graceWindowSeconds: 300,
        changedBy: "a",
        reason: "x".repeat(500),
      }),
    ).resolves.toBeDefined();
  });
});

// ─── delete() ────────────────────────────────────────────────────────────────

describe("GraceWindowService.delete()", () => {
  it("returns false when category does not exist", async () => {
    const { service } = makeService();
    const result = await service.delete("nonexistent", "admin");
    expect(result).toBe(false);
  });

  it("returns true and removes config when it exists", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    const result = await service.delete("medical", "admin");
    expect(result).toBe(true);
    expect(service.get("medical")).toBeUndefined();
  });

  it("resolves to default after deletion", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.delete("medical", "admin");
    expect(service.resolve("medical")).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
  });

  it("appends a history entry on deletion", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "a" });
    await service.delete("medical", "admin-del", "no longer needed");
    const history = service.getHistory("medical");
    const deleteEntry = history.find((h) => h.changedBy === "admin-del");
    expect(deleteEntry).toBeDefined();
    expect(deleteEntry!.previousGraceWindowSeconds).toBe(600);
    expect(deleteEntry!.newGraceWindowSeconds).toBe(DEFAULT_GRACE_WINDOW_SECONDS);
    expect(deleteEntry!.reason).toBe("no longer needed");
  });

  it("emits an audit event on deletion", async () => {
    const { service, auditEvents } = makeService();
    await service.set({ category: "fitness", graceWindowSeconds: 300, changedBy: "a" });
    auditEvents.length = 0; // clear set() event
    await service.delete("fitness", "admin");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe("grace_window.config_deleted");
  });

  it("throws on empty category string", async () => {
    const { service } = makeService();
    await expect(service.delete("", "admin")).rejects.toThrow(GraceWindowValidationError);
  });

  it("does not throw even if audit logger throws during delete", async () => {
    const store = new InMemoryGraceWindowStore();
    const throwingAudit = { log: async () => { throw new Error("audit offline"); } } as any;
    const service = new GraceWindowService({ store, auditLogger: throwingAudit });
    await service.set({ category: "beauty", graceWindowSeconds: 300, changedBy: "a" });
    await expect(service.delete("beauty", "admin")).resolves.toBe(true);
  });
});

// ─── getHistory() ─────────────────────────────────────────────────────────────

describe("GraceWindowService.getHistory()", () => {
  it("returns empty array when no changes exist", () => {
    const { service } = makeService();
    expect(service.getHistory("medical")).toEqual([]);
  });

  it("returns entries in most-recent-first order", async () => {
    let tick = 0;
    const { service } = makeService({
      nowIso: () => `2026-07-28T12:00:0${tick++}.000Z`,
    });
    await service.set({ category: "medical", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "medical", graceWindowSeconds: 600, changedBy: "b" });
    const history = service.getHistory("medical");
    expect(history[0]!.newGraceWindowSeconds).toBe(600);
    expect(history[1]!.newGraceWindowSeconds).toBe(300);
  });

  it("filters by category when category is provided", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 600, changedBy: "b" });
    const medHistory = service.getHistory("medical");
    expect(medHistory).toHaveLength(1);
    expect(medHistory[0]!.category).toBe("medical");
  });

  it("returns all entries when category is omitted", async () => {
    const { service } = makeService();
    await service.set({ category: "medical", graceWindowSeconds: 300, changedBy: "a" });
    await service.set({ category: "fitness", graceWindowSeconds: 600, changedBy: "b" });
    const allHistory = service.getHistory();
    expect(allHistory).toHaveLength(2);
  });

  it("history entries are immutable copies (mutation-safe)", async () => {
    const { service } = makeService();
    await service.set({ category: "beauty", graceWindowSeconds: 300, changedBy: "a" });
    const history = service.getHistory("beauty");
    history[0]!.newGraceWindowSeconds = 9999;
    expect(service.getHistory("beauty")[0]!.newGraceWindowSeconds).toBe(300);
  });
});

// ─── validateSetInput() (standalone) ─────────────────────────────────────────

describe("validateSetInput()", () => {
  const valid: SetGraceWindowInput = {
    category: "medical",
    graceWindowSeconds: 900,
    changedBy: "admin",
  };

  it("does not throw for valid input", () => {
    expect(() => validateSetInput(valid)).not.toThrow();
  });

  it("throws GraceWindowValidationError for empty category", () => {
    expect(() => validateSetInput({ ...valid, category: "" })).toThrow(
      GraceWindowValidationError,
    );
  });

  it("throws for whitespace-only category", () => {
    expect(() => validateSetInput({ ...valid, category: "   " })).toThrow(
      GraceWindowValidationError,
    );
  });

  it("throws for category > 100 chars", () => {
    expect(() =>
      validateSetInput({ ...valid, category: "a".repeat(101) }),
    ).toThrow(GraceWindowValidationError);
  });

  it("accepts category of exactly 100 chars", () => {
    expect(() =>
      validateSetInput({ ...valid, category: "a".repeat(100) }),
    ).not.toThrow();
  });

  it("throws for Infinity", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: Infinity }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for -Infinity", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: -Infinity }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for NaN", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: NaN }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for 0 (below min)", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: 0 }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for -1 (below min)", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: -1 }),
    ).toThrow(GraceWindowValidationError);
  });

  it("accepts MIN_GRACE_WINDOW_SECONDS", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: MIN_GRACE_WINDOW_SECONDS }),
    ).not.toThrow();
  });

  it("accepts MAX_GRACE_WINDOW_SECONDS", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS }),
    ).not.toThrow();
  });

  it("throws for MAX + 1", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: MAX_GRACE_WINDOW_SECONDS + 1 }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for float", () => {
    expect(() =>
      validateSetInput({ ...valid, graceWindowSeconds: 300.7 }),
    ).toThrow(GraceWindowValidationError);
  });

  it("throws for empty changedBy", () => {
    expect(() => validateSetInput({ ...valid, changedBy: "" })).toThrow(
      GraceWindowValidationError,
    );
  });

  it("throws when reason is a number", () => {
    expect(() => validateSetInput({ ...valid, reason: 123 as any })).toThrow(
      GraceWindowValidationError,
    );
  });

  it("throws when reason > 500 chars", () => {
    expect(() =>
      validateSetInput({ ...valid, reason: "r".repeat(501) }),
    ).toThrow(GraceWindowValidationError);
  });

  it("does not throw when reason is undefined", () => {
    const { reason: _, ...noReason } = valid;
    expect(() => validateSetInput(noReason)).not.toThrow();
  });
});

// ─── InMemoryGraceWindowStore ─────────────────────────────────────────────────

describe("InMemoryGraceWindowStore", () => {
  it("get returns undefined for unknown category", () => {
    const store = new InMemoryGraceWindowStore();
    expect(store.get("unknown")).toBeUndefined();
  });

  it("set + get round-trips correctly", () => {
    const store = new InMemoryGraceWindowStore();
    const config: GraceWindowConfig = {
      category: "medical",
      graceWindowSeconds: 600,
      updatedBy: "admin",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    store.set(config);
    expect(store.get("medical")).toEqual(config);
  });

  it("list returns all items", () => {
    const store = new InMemoryGraceWindowStore();
    store.set({ category: "a", graceWindowSeconds: 100, updatedBy: "x", updatedAt: "t" });
    store.set({ category: "b", graceWindowSeconds: 200, updatedBy: "x", updatedAt: "t" });
    expect(store.list()).toHaveLength(2);
  });

  it("appendHistory + getHistory round-trips", () => {
    const store = new InMemoryGraceWindowStore();
    const entry: GraceWindowHistoryEntry = {
      id: "h1",
      category: "medical",
      previousGraceWindowSeconds: null,
      newGraceWindowSeconds: 600,
      changedBy: "admin",
      changedAt: "2026-01-01T00:00:00.000Z",
    };
    store.appendHistory(entry);
    const history = store.getHistory("medical");
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(entry);
  });

  it("getHistory without category returns all entries", () => {
    const store = new InMemoryGraceWindowStore();
    store.appendHistory({
      id: "h1", category: "a", previousGraceWindowSeconds: null,
      newGraceWindowSeconds: 100, changedBy: "x", changedAt: "t",
    });
    store.appendHistory({
      id: "h2", category: "b", previousGraceWindowSeconds: null,
      newGraceWindowSeconds: 200, changedBy: "x", changedAt: "t",
    });
    expect(store.getHistory()).toHaveLength(2);
  });

  it("getHistory returns most-recent first (reversed)", () => {
    const store = new InMemoryGraceWindowStore();
    store.appendHistory({
      id: "h1", category: "medical", previousGraceWindowSeconds: null,
      newGraceWindowSeconds: 300, changedBy: "a", changedAt: "t1",
    });
    store.appendHistory({
      id: "h2", category: "medical", previousGraceWindowSeconds: 300,
      newGraceWindowSeconds: 600, changedBy: "b", changedAt: "t2",
    });
    const history = store.getHistory("medical");
    expect(history[0]!.id).toBe("h2");
    expect(history[1]!.id).toBe("h1");
  });
});

// ─── Singleton lifecycle ──────────────────────────────────────────────────────

describe("GraceWindowService singleton", () => {
  afterEach(() => {
    resetGraceWindowServiceSingleton();
  });

  it("getGraceWindowService returns the same instance", () => {
    const a = getGraceWindowService();
    const b = getGraceWindowService();
    expect(a).toBe(b);
  });

  it("resetGraceWindowServiceSingleton creates a fresh instance", () => {
    const a = getGraceWindowService();
    resetGraceWindowServiceSingleton();
    const b = getGraceWindowService();
    expect(a).not.toBe(b);
  });
});

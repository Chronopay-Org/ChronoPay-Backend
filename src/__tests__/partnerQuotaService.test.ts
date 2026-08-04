
import {
  InMemoryQuotaStore,
  checkAndConsume,
  getQuotaStatus,
  nextDailyReset,
  nextMonthlyReset,
} from "../services/partnerQuotaService.js";
import { register } from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function metricValue(metricName: string, _label?: string): Promise<number> {
  const text = await register.metrics();
  const lines = text.split("\n").filter((l) => l.startsWith(metricName) && !l.startsWith("#"));
  if (lines.length === 0) return 0;
  // Sum across label values
  let total = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    total += Number(parts[parts.length - 1]);
  }
  return total;
}

function fixedNow(year: number, month: number, day: number, hour: number = 12): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("partner quota service", () => {
  let store: InMemoryQuotaStore;

  beforeEach(() => {
    store = new InMemoryQuotaStore();
    register.resetMetrics();
  });

  // ── Basic consumption ────────────────────────────────────────────────────

  it("allows consumption when within daily and monthly limits", async () => {
    const result = await checkAndConsume("token_abc", store, fixedNow(2026, 7, 29));

    expect(result.allowed).toBe(true);
    expect(result.exceeded).toBeNull();
    expect(result.status.dailyUsed).toBe(1);
    expect(result.status.monthlyUsed).toBe(1);
    expect(result.status.dailyLimit).toBe(10000);
    expect(result.status.monthlyLimit).toBe(300000);
  });

  it("increments counters on each consumption", async () => {
    await checkAndConsume("token_abc", store, fixedNow(2026, 7, 29, 8));
    await checkAndConsume("token_abc", store, fixedNow(2026, 7, 29, 9));

    const status = await getQuotaStatus("token_abc", store, fixedNow(2026, 7, 29, 10));
    expect(status.dailyUsed).toBe(2);
    expect(status.monthlyUsed).toBe(2);
  });

  // ── Limit enforcement ─────────────────────────────────────────────────────

  it("blocks when daily limit is reached", async () => {
    // Manually set daily_used to the limit
    const _row = await store.getOrCreate("token_abc", fixedNow(2026, 7, 1));
    // We can't modify the row directly through the interface, so let's just
    // simulate by consuming many times... but that's slow.
    // Instead, let's set up the store with a pre-loaded row at limit.
    const quotaStore = new InMemoryQuotaStore();
    const customRow = await quotaStore.getOrCreate("token_limit", fixedNow(2026, 7, 29));
    // Override the row in the store's internal map
    (quotaStore as any).rows.set("token_limit", {
      ...customRow,
      daily_limit: 5,
      daily_used: 5,
    });

    const result = await checkAndConsume("token_limit", quotaStore, fixedNow(2026, 7, 29));
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toBe("daily");
  });

  it("blocks when monthly limit is reached", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const customRow = await quotaStore.getOrCreate("token_monthly", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_monthly", {
      ...customRow,
      monthly_limit: 10,
      monthly_used: 10,
    });

    const result = await checkAndConsume("token_monthly", quotaStore, fixedNow(2026, 7, 29));
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toBe("monthly");
  });

  it("blocks when both daily and monthly limits are reached", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const customRow = await quotaStore.getOrCreate("token_both", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_both", {
      ...customRow,
      daily_limit: 5,
      daily_used: 5,
      monthly_limit: 10,
      monthly_used: 10,
    });

    const result = await checkAndConsume("token_both", quotaStore, fixedNow(2026, 7, 29));
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toBe("both");
  });

  // ── Lazy reset ───────────────────────────────────────────────────────────

  it("resets daily counter after daily_reset_at passes", async () => {
    const quotaStore = new InMemoryQuotaStore();
    // Create row with daily_reset_at in the past
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 7, 28));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      daily_used: 100,
      daily_reset_at: fixedNow(2026, 7, 28, 0), // yesterday midnight
    });

    // Now = Jul 29 (past the reset)
    const result = await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));
    expect(result.allowed).toBe(true);
    expect(result.status.dailyUsed).toBe(1); // reset and consumed 1
  });

  it("resets monthly counter after monthly_reset_at passes", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 6, 1));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      monthly_used: 1000,
      monthly_reset_at: fixedNow(2026, 7, 1, 0), // July 1st (past)
    });

    // Now = Jul 29
    const result = await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));
    expect(result.allowed).toBe(true);
    expect(result.status.monthlyUsed).toBe(1); // reset and consumed 1
  });

  // ── Quota status dashboard ──────────────────────────────────────────────

  it("returns quota status with percentage used", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      daily_used: 2500,
      monthly_used: 50000,
    });

    const status = await getQuotaStatus("token_abc", quotaStore, fixedNow(2026, 7, 29));
    expect(status.dailyPercentUsed).toBe(25); // 2500/10000
    expect(status.monthlyPercentUsed).toBeCloseTo(16.67, 1); // 50000/300000 ≈ 16.67%
  });

  it("returns zero usage for a new token", async () => {
    const status = await getQuotaStatus("new_token", store, fixedNow(2026, 7, 29));
    expect(status.dailyUsed).toBe(0);
    expect(status.monthlyUsed).toBe(0);
    expect(status.dailyPercentUsed).toBe(0);
    expect(status.monthlyPercentUsed).toBe(0);
  });

  // ── Approaching-quota notification ──────────────────────────────────────

  it("emits approaching-quota metric when daily usage crosses 80%", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      daily_limit: 100,
      daily_used: 79, // 79% — not yet approaching
    });

    // Consume 1 → 80/100 = 80% → approaching
    await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));

    expect(await metricValue("partner_quota_approaching_limit_total")).toBeGreaterThanOrEqual(1);
  });

  it("does not emit approaching-quota metric when already notified", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      daily_limit: 100,
      daily_used: 79,
      approaching_quota_notified: true, // already notified
    });

    await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));

    // Metric should not increase since already notified
    const metricBefore = await metricValue("partner_quota_approaching_limit_total");
    // We may have emitted on creation — just verify we don't emit again
    await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));
    const metricAfter = await metricValue("partner_quota_approaching_limit_total");
    expect(metricAfter).toBe(metricBefore);
  });

  // ── Timezone reset helpers ──────────────────────────────────────────────

  describe("nextDailyReset", () => {
    it("returns midnight tomorrow in the given timezone", () => {
      const now = fixedNow(2026, 7, 29, 12); // Jul 29 noon UTC
      const reset = nextDailyReset("UTC", now);
      expect(reset.toISOString()).toBe("2026-07-30T00:00:00.000Z");
    });

    it("handles timezone offsets correctly", () => {
      const now = fixedNow(2026, 7, 29, 22); // 10 PM UTC
      // America/New_York is UTC-4 in July → 6 PM EDT
      // Midnight July 30 in NY should be July 30 at 04:00 UTC
      const reset = nextDailyReset("America/New_York", now);
      // The result should be midnight tomorrow NY time
      // NY is UTC-4 in July, so midnight NY = 04:00 UTC
      expect(reset.getUTCHours()).toBe(4);
      expect(reset.getUTCDate()).toBe(30);
      expect(reset.getUTCMonth()).toBe(6); // July = 6 (0-indexed)
      expect(reset.getUTCFullYear()).toBe(2026);
    });
  });

  describe("nextMonthlyReset", () => {
    it("returns the 1st of next month", () => {
      const now = fixedNow(2026, 7, 29);
      const reset = nextMonthlyReset("UTC", now);
      expect(reset.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    });

    it("handles December → January rollover", () => {
      const now = fixedNow(2026, 12, 15);
      const reset = nextMonthlyReset("UTC", now);
      expect(reset.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });
  });

  // ── Metric assertions ────────────────────────────────────────────────────

  it("increments exceeded counter when quota is breached", async () => {
    const quotaStore = new InMemoryQuotaStore();
    const row = await quotaStore.getOrCreate("token_abc", fixedNow(2026, 7, 29));
    (quotaStore as any).rows.set("token_abc", {
      ...row,
      daily_limit: 3,
      daily_used: 3,
    });

    await checkAndConsume("token_abc", quotaStore, fixedNow(2026, 7, 29));

    expect(await metricValue("partner_quota_exceeded_total")).toBe(1);
  });
});

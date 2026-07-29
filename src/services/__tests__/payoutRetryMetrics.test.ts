import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  payoutRetryRollup,
  resolveRetryOutcome,
} from "../../scheduler/payoutRetryMetrics.js";

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("payoutRetryRollup", () => {
  beforeEach(() => {
    payoutRetryRollup.reset();
  });

  describe("initial state after reset", () => {
    it("starts with all counters at zero", () => {
      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(0);
      expect(snap.scheduled).toBe(0);
      expect(snap.exhausted).toBe(0);
      expect(snap.ceilingHits).toBe(0);
    });
  });

  describe("recordAttempt — outcome: scheduled", () => {
    it("increments total attempts and scheduled counter", () => {
      payoutRetryRollup.recordAttempt("ach", "scheduled", 1_234, 5_000);
      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(1);
      expect(snap.scheduled).toBe(1);
      expect(snap.exhausted).toBe(0);
      expect(snap.ceilingHits).toBe(0);
    });
  });

  describe("recordAttempt — outcome: exhausted", () => {
    it("increments total attempts and exhausted counter", () => {
      payoutRetryRollup.recordAttempt("sepa", "exhausted", 0, 30_000);
      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(1);
      expect(snap.scheduled).toBe(0);
      expect(snap.exhausted).toBe(1);
      expect(snap.ceilingHits).toBe(0);
    });
  });

  describe("recordAttempt — outcome: ceiling_hit", () => {
    it("increments total attempts and ceilingHits counter", () => {
      payoutRetryRollup.recordAttempt("stellar", "ceiling_hit", 29_999, 30_000);
      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(1);
      expect(snap.scheduled).toBe(0);
      expect(snap.exhausted).toBe(0);
      expect(snap.ceilingHits).toBe(1);
    });
  });

  describe("multiple calls accumulate correctly", () => {
    it("sums all counters across mixed outcomes", () => {
      payoutRetryRollup.recordAttempt("ach", "scheduled", 500, 1_000);
      payoutRetryRollup.recordAttempt("ach", "scheduled", 800, 2_000);
      payoutRetryRollup.recordAttempt("sepa", "ceiling_hit", 29_000, 30_000);
      payoutRetryRollup.recordAttempt("wire", "exhausted", 0, 10_000);

      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(4);
      expect(snap.scheduled).toBe(2);
      expect(snap.ceilingHits).toBe(1);
      expect(snap.exhausted).toBe(1);
    });

    it("does not mix counters when called for different providers", () => {
      payoutRetryRollup.recordAttempt("ach", "scheduled", 100, 1_000);
      payoutRetryRollup.recordAttempt("crypto", "exhausted", 0, 5_000);

      const snap = payoutRetryRollup.snapshot();
      // Both calls contribute to the shared rollup totals
      expect(snap.attempts).toBe(2);
      expect(snap.scheduled).toBe(1);
      expect(snap.exhausted).toBe(1);
    });
  });

  describe("reset", () => {
    it("zeroes all counters after accumulation", () => {
      payoutRetryRollup.recordAttempt("ach", "scheduled", 100, 1_000);
      payoutRetryRollup.recordAttempt("ach", "exhausted", 0, 1_000);
      payoutRetryRollup.reset();

      const snap = payoutRetryRollup.snapshot();
      expect(snap.attempts).toBe(0);
      expect(snap.scheduled).toBe(0);
      expect(snap.exhausted).toBe(0);
      expect(snap.ceilingHits).toBe(0);
    });
  });

  describe("snapshot immutability", () => {
    it("snapshot does not reflect mutations made after the call", () => {
      payoutRetryRollup.recordAttempt("ach", "scheduled", 100, 1_000);
      const snap = payoutRetryRollup.snapshot();

      // Record another attempt after snapshot was taken
      payoutRetryRollup.recordAttempt("ach", "scheduled", 200, 2_000);

      // Original snapshot must be unchanged
      expect(snap.attempts).toBe(1);
    });
  });
});

// ─── resolveRetryOutcome ──────────────────────────────────────────────────────

describe("resolveRetryOutcome", () => {
  it("returns 'exhausted' when isExhausted=true, regardless of cap vs ceiling", () => {
    // Even if cap < ceiling, exhausted takes priority
    expect(resolveRetryOutcome(1_000, 30_000, true)).toBe("exhausted");
    expect(resolveRetryOutcome(30_000, 30_000, true)).toBe("exhausted");
  });

  it("returns 'ceiling_hit' when cap equals the ceiling and not exhausted", () => {
    expect(resolveRetryOutcome(30_000, 30_000, false)).toBe("ceiling_hit");
  });

  it("returns 'scheduled' when cap is below ceiling and not exhausted", () => {
    expect(resolveRetryOutcome(4_000, 30_000, false)).toBe("scheduled");
    expect(resolveRetryOutcome(0, 30_000, false)).toBe("scheduled");
  });

  it("returns 'ceiling_hit' when ceiling < base and cap is forced to ceiling from attempt 0", () => {
    // ceiling=500, cap=500 (clamped) → ceiling_hit
    expect(resolveRetryOutcome(500, 500, false)).toBe("ceiling_hit");
  });

  it("'exhausted' is mutually exclusive with 'ceiling_hit'", () => {
    const outcome = resolveRetryOutcome(30_000, 30_000, true);
    expect(outcome).not.toBe("ceiling_hit");
  });

  it("'scheduled' indicates the exponential window has not reached the ceiling", () => {
    // cap=1000 < ceiling=30_000 → still growing, not clamped
    const outcome = resolveRetryOutcome(1_000, 30_000, false);
    expect(outcome).toBe("scheduled");
  });

  describe("edge cases", () => {
    it("cap=0, ceiling=1, not exhausted → scheduled (cap < ceiling)", () => {
      expect(resolveRetryOutcome(0, 1, false)).toBe("scheduled");
    });

    it("cap=1, ceiling=1, not exhausted → ceiling_hit", () => {
      expect(resolveRetryOutcome(1, 1, false)).toBe("ceiling_hit");
    });
  });
});

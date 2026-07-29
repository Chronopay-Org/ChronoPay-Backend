import { describe, it, expect, beforeEach } from "@jest/globals";
import { DisputeArbitrationQueueService } from "../disputeArbitrationQueue.js";

describe("DisputeArbitrationQueueService", () => {
  let service: DisputeArbitrationQueueService;
  const BASE_NOW = 1_700_000_000_000;

  beforeEach(() => {
    service = new DisputeArbitrationQueueService();
  });

  // ── Core ordering ─────────────────────────────────────────────────────────

  it("returns disputes in priority order (value + tier + age)", () => {
    // Platinum, high-value dispute should rank first
    service.enqueueDispute({
      id: "high",
      amount: 10_000,
      buyerTier: "platinum",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    // Bronze, low-value dispute should rank last
    service.enqueueDispute({
      id: "low",
      amount: 100,
      buyerTier: "bronze",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    // Silver, mid-value sits in the middle
    service.enqueueDispute({
      id: "mid",
      amount: 1_000,
      buyerTier: "silver",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });

    const ordered = service.list(BASE_NOW + 60_000);
    expect(ordered.map((item) => item.disputeId)).toEqual(["high", "mid", "low"]);
  });

  it("uses the same-score tie-breaker to preserve FIFO ordering", () => {
    const now = BASE_NOW;

    service.enqueueDispute({
      id: "disp-1",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: now,
      queuedAt: now,
    });
    service.enqueueDispute({
      id: "disp-2",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: now + 60_000,
      queuedAt: now + 60_000,
    });

    const ordered = service.list(now + 10_000);
    expect(ordered.map((entry) => entry.disputeId)).toEqual(["disp-1", "disp-2"]);
  });

  it("ranks higher value disputes above lower value disputes (same tier, same age)", () => {
    service.enqueueDispute({
      id: "small",
      amount: 500,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    service.enqueueDispute({
      id: "large",
      amount: 5_000,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });

    const ordered = service.list(BASE_NOW + 10_000);
    expect(ordered[0].disputeId).toBe("large");
    expect(ordered[1].disputeId).toBe("small");
    expect(ordered[0].score).toBeGreaterThan(ordered[1].score ?? 0);
  });

  it("ranks higher buyer tiers above lower tiers (same value, same age)", () => {
    service.enqueueDispute({
      id: "bronze-d",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    service.enqueueDispute({
      id: "platinum-d",
      amount: 1_000,
      buyerTier: "platinum",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    service.enqueueDispute({
      id: "silver-d",
      amount: 1_000,
      buyerTier: "silver",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });

    const ordered = service.list(BASE_NOW + 10_000);
    expect(ordered.map((e) => e.disputeId)).toEqual(["platinum-d", "silver-d", "bronze-d"]);
  });

  // ── Empty queue / missing items ───────────────────────────────────────────

  it("returns an empty array when listing an empty queue", () => {
    expect(service.list(BASE_NOW)).toEqual([]);
  });

  it("returns an empty dashboard when no disputes are queued", () => {
    expect(service.getDashboard(BASE_NOW)).toEqual({
      total: 0,
      depthByTier: {
        bronze: 0,
        silver: 0,
        gold: 0,
        platinum: 0,
      },
      next: null,
    });
  });

  it("does not throw when removing a non-existent dispute", () => {
    expect(() => service.removeDispute("does-not-exist")).not.toThrow();
  });

  it("does not throw when updating tier of a non-existent dispute", () => {
    expect(() => service.updateTier("does-not-exist", "platinum")).not.toThrow();
  });

  // ── Reindex / aging ──────────────────────────────────────────────────────

  it("reindexes older disputes upward and respects tier upgrades mid-wait", () => {
    const now = BASE_NOW;

    service.enqueueDispute({
      id: "disp-1",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: now,
      queuedAt: now,
    });
    service.enqueueDispute({
      id: "disp-2",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: now + 60_000,
      queuedAt: now + 60_000,
    });

    service.updateTier("disp-2", "platinum");

    const reindexed = service.reindex(now + 20 * 60_000);
    expect(reindexed.find((entry) => entry.disputeId === "disp-2")?.score).toBeGreaterThan(
      reindexed.find((entry) => entry.disputeId === "disp-1")?.score ?? -Infinity,
    );
  });

  it("fair aging: an older bronze dispute can outrank a newer gold dispute if the age gap is large enough", () => {
    // Gold dispute queued now
    service.enqueueDispute({
      id: "gold-now",
      amount: 1_000,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    // Bronze dispute queued much earlier (age bonus accumulates)
    service.enqueueDispute({
      id: "bronze-old",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: BASE_NOW - 86_400_000, // 24 hours earlier
      queuedAt: BASE_NOW - 86_400_000,
    });

    // Bronze-old has been queued for 24h, giving it 1440 * 0.05 = 72 age bonus
    // At BASE_NOW:
    //   gold-now: 1000*0.001 + 3*10 + 0 = 1 + 30 + 0 = 31
    //   bronze-old: 1000*0.001 + 1*10 + 1440*0.05 = 1 + 10 + 72 = 83
    const list = service.list(BASE_NOW);
    expect(list[0].disputeId).toBe("bronze-old");
    expect((list.find((e) => e.disputeId === "bronze-old")?.score ?? 0)).toBeGreaterThan(
      list.find((e) => e.disputeId === "gold-now")?.score ?? 0
    );
  });

  it("fair aging: the age bonus grows linearly as disputes wait longer", () => {
    service.enqueueDispute({
      id: "d1",
      amount: 500,
      buyerTier: "silver",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });

    const scoreAt1h = service.list(BASE_NOW + 3_600_000)[0].score ?? 0;
    const scoreAt2h = service.list(BASE_NOW + 7_200_000)[0].score ?? 0;
    const scoreAt3h = service.list(BASE_NOW + 10_800_000)[0].score ?? 0;

    // Age bonus is 0.05 per minute: 1h=3, 2h=6, 3h=9
    // Difference between consecutive hours should be ~3.0
    expect(scoreAt2h - scoreAt1h).toBeCloseTo(3.0, 1);
    expect(scoreAt3h - scoreAt2h).toBeCloseTo(3.0, 1);
  });

  it("multiple reindex calls produce consistent scores", () => {
    service.enqueueDispute({
      id: "d1",
      amount: 1_000,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });

    const first = service.reindex(BASE_NOW + 60_000);
    const second = service.reindex(BASE_NOW + 60_000);
    expect(first[0].score).toBe(second[0].score);
  });

  // ── Tier upgrades ────────────────────────────────────────────────────────

  it("updateTier changes the priority of an enqueued dispute", () => {
    service.enqueueDispute({
      id: "d1",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    service.enqueueDispute({
      id: "d2",
      amount: 1_000,
      buyerTier: "bronze",
      createdAt: BASE_NOW + 60_000,
      queuedAt: BASE_NOW + 60_000,
    });

    // Upgrade the newer one to platinum
    service.updateTier("d2", "platinum");

    const ordered = service.list(BASE_NOW + 10_000);
    expect(ordered[0].disputeId).toBe("d2");
    expect(ordered[0].buyerTier).toBe("platinum");
  });

  // ── Dashboard ─────────────────────────────────────────────────────────────

  it("dashboard depthByTier reflects the correct counts", () => {
    service.enqueueDispute({ id: "d1", amount: 100, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d2", amount: 200, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d3", amount: 300, buyerTier: "silver", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d4", amount: 400, buyerTier: "gold", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d5", amount: 500, buyerTier: "platinum", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d6", amount: 600, buyerTier: "platinum", createdAt: BASE_NOW, queuedAt: BASE_NOW });

    const dashboard = service.getDashboard(BASE_NOW);
    expect(dashboard.total).toBe(6);
    expect(dashboard.depthByTier.bronze).toBe(2);
    expect(dashboard.depthByTier.silver).toBe(1);
    expect(dashboard.depthByTier.gold).toBe(1);
    expect(dashboard.depthByTier.platinum).toBe(2);
    expect(dashboard.next?.disputeId).toBe("d6"); // Platinum, highest value
  });

  it("dashboard next is null for empty queue", () => {
    const dashboard = service.getDashboard(BASE_NOW);
    expect(dashboard.next).toBeNull();
  });

  // ── enqueueDispute edge cases ────────────────────────────────────────────

  it("accepts disputeId field", () => {
    service.enqueueDispute({
      disputeId: "custom-id",
      amount: 500,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    const list = service.list(BASE_NOW);
    expect(list[0].disputeId).toBe("custom-id");
  });

  it("falls back to default id when neither disputeId nor id is provided", () => {
    service.enqueueDispute({
      amount: 500,
      buyerTier: "gold",
      createdAt: BASE_NOW,
      queuedAt: BASE_NOW,
    });
    const list = service.list(BASE_NOW);
    expect(list[0].disputeId).toBe("dispute-queue-item");
  });

  // ── Removal ──────────────────────────────────────────────────────────────

  it("removes dispute from the queue", () => {
    service.enqueueDispute({ id: "d1", amount: 100, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d2", amount: 200, buyerTier: "silver", createdAt: BASE_NOW, queuedAt: BASE_NOW });

    service.removeDispute("d1");
    const list = service.list(BASE_NOW);
    expect(list).toHaveLength(1);
    expect(list[0].disputeId).toBe("d2");
  });

  it("removed disputes no longer appear in dashboard", () => {
    service.enqueueDispute({ id: "d1", amount: 100, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d2", amount: 200, buyerTier: "platinum", createdAt: BASE_NOW, queuedAt: BASE_NOW });

    service.removeDispute("d2");
    const dashboard = service.getDashboard(BASE_NOW);
    expect(dashboard.total).toBe(1);
    expect(dashboard.depthByTier.platinum).toBe(0);
    expect(dashboard.depthByTier.bronze).toBe(1);
    expect(dashboard.next?.disputeId).toBe("d1");
  });

  // ── Score computation details ────────────────────────────────────────────

  it("returns items with computed score field", () => {
    service.enqueueDispute({ id: "d1", amount: 500, buyerTier: "gold", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    const list = service.list(BASE_NOW);
    expect(list[0].score).toBeDefined();
    expect(typeof list[0].score).toBe("number");
  });

  it("score increases with age (same dispute, different now timestamps)", () => {
    service.enqueueDispute({ id: "d1", amount: 500, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });

    const scoreEarly = service.list(BASE_NOW + 60_000)[0].score ?? 0;
    const scoreLater = service.list(BASE_NOW + 3_600_000)[0].score ?? 0; // 1 hour later
    expect(scoreLater).toBeGreaterThan(scoreEarly);
  });

  // ── Full lifecycle ───────────────────────────────────────────────────────

  it("handles a complete dispute lifecycle (enqueue → reindex → dequeue)", () => {
    service.enqueueDispute({ id: "d1", amount: 1_000, buyerTier: "bronze", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d2", amount: 2_000, buyerTier: "silver", createdAt: BASE_NOW, queuedAt: BASE_NOW });
    service.enqueueDispute({ id: "d3", amount: 3_000, buyerTier: "platinum", createdAt: BASE_NOW, queuedAt: BASE_NOW });

    // Reindex after 30 minutes
    const before = service.reindex(BASE_NOW + 1_800_000);
    expect(before).toHaveLength(3);

    // Dequeue the top item (simulate adjudication)
    const top = before[0];
    service.removeDispute(top.disputeId);

    const after = service.list(BASE_NOW + 1_800_000);
    expect(after).toHaveLength(2);
    expect(after.find((e) => e.disputeId === top.disputeId)).toBeUndefined();
  });
});

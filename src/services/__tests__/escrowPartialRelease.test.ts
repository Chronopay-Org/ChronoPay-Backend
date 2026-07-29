/**
 * escrowPartialRelease.test.ts
 *
 * Tests for the milestone-based partial-release service.
 * Issue #440 – Add escrow partial-release logic for milestone-based
 * multi-hour slots.
 */

import {
  EscrowPartialReleaseService,
  BookingNotFoundError,
  MilestoneNotFoundError,
  MilestoneAlreadyReleasedError,
  OverReleaseError,
  MilestoneNotAuthorizedError,
  InvalidMilestoneAmountError,
  MilestoneAmountExceedsHoldError,
} from "../../services/escrowPartialRelease.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HOLD = 300_000_000; // 30 XLM in stroops

const MILESTONES = [
  { milestoneId: "m-1", description: "Hour 1 complete", amountStroops: 100_000_000 },
  { milestoneId: "m-2", description: "Hour 2 complete", amountStroops: 100_000_000 },
  { milestoneId: "m-3", description: "Hour 3 complete", amountStroops: 100_000_000 },
];

const NOW = "2026-07-28T10:00:00.000Z";
const mockNow = () => NOW;

function makeService() {
  return new EscrowPartialReleaseService();
}

// ─── registerBooking ──────────────────────────────────────────────────────────

describe("registerBooking", () => {
  it("creates a booking with the correct hold and milestones", () => {
    const svc = makeService();
    const booking = svc.registerBooking("b-001", HOLD, MILESTONES);
    expect(booking.bookingId).toBe("b-001");
    expect(booking.holdAmountStroops).toBe(HOLD);
    expect(booking.milestones).toHaveLength(3);
    expect(booking.milestones.every((m) => m.released === false)).toBe(true);
  });

  it("initial remaining balance equals hold amount", () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    expect(svc.getRemainingBalance("b-001")).toBe(HOLD);
  });

  it("allows milestones whose total equals the hold amount", () => {
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, MILESTONES)).not.toThrow();
  });

  it("allows milestones whose total is less than the hold amount", () => {
    const partial = [{ milestoneId: "m-1", description: "d", amountStroops: 50_000_000 }];
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, partial)).not.toThrow();
  });

  it("throws MilestoneAmountExceedsHoldError when total > holdAmountStroops", () => {
    const over = [
      { milestoneId: "m-1", description: "d1", amountStroops: 200_000_000 },
      { milestoneId: "m-2", description: "d2", amountStroops: 200_000_000 },
    ];
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, over)).toThrow(
      MilestoneAmountExceedsHoldError,
    );
  });

  it("throws InvalidMilestoneAmountError for zero amount", () => {
    const invalid = [{ milestoneId: "m-zero", description: "d", amountStroops: 0 }];
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, invalid)).toThrow(
      InvalidMilestoneAmountError,
    );
  });

  it("throws InvalidMilestoneAmountError for negative amount", () => {
    const invalid = [{ milestoneId: "m-neg", description: "d", amountStroops: -1 }];
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, invalid)).toThrow(
      InvalidMilestoneAmountError,
    );
  });

  it("throws InvalidMilestoneAmountError for fractional amount", () => {
    const invalid = [{ milestoneId: "m-frac", description: "d", amountStroops: 1.5 }];
    const svc = makeService();
    expect(() => svc.registerBooking("b-001", HOLD, invalid)).toThrow(
      InvalidMilestoneAmountError,
    );
  });
});

// ─── authorizeMilestone ───────────────────────────────────────────────────────

describe("authorizeMilestone", () => {
  it("stamps the authorizedBy field on the milestone", () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin-007");
    const booking = svc.getBooking("b-001")!;
    const m = booking.milestones.find((m) => m.milestoneId === "m-1");
    expect(m!.authorizedBy).toBe("admin-007");
  });

  it("throws BookingNotFoundError for unknown booking", () => {
    const svc = makeService();
    expect(() => svc.authorizeMilestone("ghost", "m-1", "admin")).toThrow(
      BookingNotFoundError,
    );
  });

  it("throws MilestoneNotFoundError for unknown milestone", () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    expect(() => svc.authorizeMilestone("b-001", "nonexistent", "admin")).toThrow(
      MilestoneNotFoundError,
    );
  });
});

// ─── releasePartial – happy path ──────────────────────────────────────────────

describe("releasePartial – happy path", () => {
  it("releases the first milestone and returns correct result", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin");

    const result = await svc.releasePartial("b-001", "m-1", mockNow);
    expect(result.bookingId).toBe("b-001");
    expect(result.milestoneId).toBe("m-1");
    expect(result.amountReleasedStroops).toBe(100_000_000);
    expect(result.remainingBalanceStroops).toBe(200_000_000);
  });

  it("remaining balance decreases by the milestone amount after each release", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);

    svc.authorizeMilestone("b-001", "m-1", "admin");
    await svc.releasePartial("b-001", "m-1", mockNow);
    expect(svc.getRemainingBalance("b-001")).toBe(200_000_000);

    svc.authorizeMilestone("b-001", "m-2", "admin");
    await svc.releasePartial("b-001", "m-2", mockNow);
    expect(svc.getRemainingBalance("b-001")).toBe(100_000_000);

    svc.authorizeMilestone("b-001", "m-3", "admin");
    await svc.releasePartial("b-001", "m-3", mockNow);
    expect(svc.getRemainingBalance("b-001")).toBe(0);
  });

  it("sum invariant: remaining = hold - sum(released)", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);

    for (const m of MILESTONES) {
      svc.authorizeMilestone("b-001", m.milestoneId, "admin");
      await svc.releasePartial("b-001", m.milestoneId, mockNow);

      const booking = svc.getBooking("b-001")!;
      const releasedSum = booking.milestones
        .filter((ms) => ms.released)
        .reduce((s, ms) => s + ms.amountStroops, 0);
      const remaining = svc.getRemainingBalance("b-001");
      expect(HOLD - releasedSum).toBe(remaining);
    }
  });

  it("stamps the milestone with releasedAt timestamp", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin");
    await svc.releasePartial("b-001", "m-1", mockNow);

    const milestone = svc
      .getBooking("b-001")!
      .milestones.find((m) => m.milestoneId === "m-1")!;
    expect(milestone.releasedAt).toBe(NOW);
  });

  it("stamps the milestone with a 64-char hex releaseTxHash", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin");
    const result = await svc.releasePartial("b-001", "m-1", mockNow);

    expect(result.txHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.txHash)).toBe(true);
  });
});

// ─── releasePartial – error paths ─────────────────────────────────────────────

describe("releasePartial – error paths", () => {
  it("throws BookingNotFoundError for unknown booking", async () => {
    const svc = makeService();
    await expect(svc.releasePartial("ghost", "m-1", mockNow)).rejects.toThrow(
      BookingNotFoundError,
    );
  });

  it("throws MilestoneNotFoundError for unknown milestone", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    await expect(svc.releasePartial("b-001", "nonexistent", mockNow)).rejects.toThrow(
      MilestoneNotFoundError,
    );
  });

  it("throws MilestoneNotAuthorizedError when milestone has not been authorised", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    // No authorizeMilestone call
    await expect(svc.releasePartial("b-001", "m-1", mockNow)).rejects.toThrow(
      MilestoneNotAuthorizedError,
    );
  });

  it("throws MilestoneAlreadyReleasedError on duplicate release", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin");
    await svc.releasePartial("b-001", "m-1", mockNow);

    await expect(svc.releasePartial("b-001", "m-1", mockNow)).rejects.toThrow(
      MilestoneAlreadyReleasedError,
    );
  });

  it("throws OverReleaseError when milestone amount exceeds remaining balance", async () => {
    // Set up a booking where m-1+m-2 = hold, but we add m-3 with an extra amount
    const svc = makeService();
    const tightMilestones = [
      { milestoneId: "big", description: "big chunk", amountStroops: 250_000_000 },
      { milestoneId: "small", description: "small chunk", amountStroops: 50_000_000 },
    ];
    svc.registerBooking("b-001", HOLD, tightMilestones);

    // Release the large chunk first
    svc.authorizeMilestone("b-001", "big", "admin");
    await svc.releasePartial("b-001", "big", mockNow);
    // Now remaining = 50_000_000

    // Forcibly inflate the small milestone amount to exceed remaining
    // (simulate a corrupted milestone or test the guard directly)
    const booking = svc.getBooking("b-001")!;
    const small = booking.milestones.find((m) => m.milestoneId === "small")!;
    // @ts-expect-error — intentionally bypassing type safety to test the guard
    small.amountStroops = 100_000_000; // now exceeds remaining 50M

    svc.authorizeMilestone("b-001", "small", "admin");
    await expect(svc.releasePartial("b-001", "small", mockNow)).rejects.toThrow(
      OverReleaseError,
    );
  });

  it("OverReleaseError carries the correct booking/milestone/amount fields", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", 10, [
      { milestoneId: "big", description: "d", amountStroops: 10 },
      { milestoneId: "extra", description: "d", amountStroops: 10 },
    ]);

    // Release the first milestone (hold = 10, after release remaining = 0)
    svc.authorizeMilestone("b-001", "big", "admin");
    await svc.releasePartial("b-001", "big", mockNow);

    // Inflate extra milestone to test the error fields
    const booking = svc.getBooking("b-001")!;
    const extra = booking.milestones.find((m) => m.milestoneId === "extra")!;
    svc.authorizeMilestone("b-001", "extra", "admin");

    try {
      await svc.releasePartial("b-001", "extra", mockNow);
      fail("Expected OverReleaseError");
    } catch (err) {
      expect(err).toBeInstanceOf(OverReleaseError);
      const e = err as OverReleaseError;
      expect(e.bookingId).toBe("b-001");
      expect(e.milestoneId).toBe("extra");
      expect(e.requestedStroops).toBe(extra.amountStroops);
      expect(e.remainingStroops).toBe(0);
    }
  });
});

// ─── Concurrency / serialisation ─────────────────────────────────────────────

describe("releasePartial – concurrency", () => {
  it("concurrent releases for different milestones serialise correctly", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    for (const m of MILESTONES) {
      svc.authorizeMilestone("b-001", m.milestoneId, "admin");
    }

    // Fire all three releases simultaneously
    const [r1, r2, r3] = await Promise.all([
      svc.releasePartial("b-001", "m-1", mockNow),
      svc.releasePartial("b-001", "m-2", mockNow),
      svc.releasePartial("b-001", "m-3", mockNow),
    ]);

    // All succeed, final remaining balance is 0
    expect(r1.amountReleasedStroops).toBe(100_000_000);
    expect(r2.amountReleasedStroops).toBe(100_000_000);
    expect(r3.amountReleasedStroops).toBe(100_000_000);
    expect(svc.getRemainingBalance("b-001")).toBe(0);
  });

  it("duplicate concurrent releases resolve with one success and one MilestoneAlreadyReleasedError", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    svc.authorizeMilestone("b-001", "m-1", "admin");

    const results = await Promise.allSettled([
      svc.releasePartial("b-001", "m-1", mockNow),
      svc.releasePartial("b-001", "m-1", mockNow),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MilestoneAlreadyReleasedError,
    );
  });
});

// ─── getRemainingBalance ──────────────────────────────────────────────────────

describe("getRemainingBalance", () => {
  it("throws BookingNotFoundError for unknown bookingId", () => {
    const svc = makeService();
    expect(() => svc.getRemainingBalance("ghost")).toThrow(BookingNotFoundError);
  });

  it("stays equal to hold when no milestones released", () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    expect(svc.getRemainingBalance("b-001")).toBe(HOLD);
  });

  it("reaches zero only when every milestone is released", async () => {
    const svc = makeService();
    svc.registerBooking("b-001", HOLD, MILESTONES);
    for (const m of MILESTONES) {
      svc.authorizeMilestone("b-001", m.milestoneId, "admin");
      await svc.releasePartial("b-001", m.milestoneId, mockNow);
    }
    expect(svc.getRemainingBalance("b-001")).toBe(0);
  });
});

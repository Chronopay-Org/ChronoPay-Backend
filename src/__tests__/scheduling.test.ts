import {
  SchedulingService,
  SlotNotBookableError,
  SlotNotFoundError,
  CancellationAfterSlotStartError,
  EscrowRefundLedgerIntegrityError,
  deriveRefundLedgerHash,
  refundEvents,
} from "../services/schedulingService.js";
import { InMemorySlotRepository, type SlotRecord } from "../modules/slots/slot-repository.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
  type PricingSnapshot,
} from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-1",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: true,
    ...overrides,
  };
}

const actor = { userId: "customer-1", role: "customer" as const, claims: {} as any };
const admin = { userId: "admin-1", role: "admin" as const, claims: {} as any };

// ─── SchedulingService ───────────────────────────────────────────────────────

describe("SchedulingService", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let scheduler: SchedulingService;

  beforeEach(() => {
    slotRepo = new InMemorySlotRepository([makeSlot()]);
    intentRepo = new InMemoryBookingIntentRepository();
    scheduler = new SchedulingService(slotRepo, intentRepo);
  });

  describe("reserveSlot", () => {
    it("marks a bookable slot as not bookable", async () => {
      scheduler.reserveSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("throws SlotNotFoundError for a non-existent slot", async () => {
      expect(() => scheduler.reserveSlot("slot-unknown")).toThrow(SlotNotFoundError);
    });

    it("throws SlotNotBookableError when slot is already reserved", async () => {
      scheduler.reserveSlot("slot-1");
      expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    });
  });

  describe("releaseSlot", () => {
    it("marks a reserved slot back to bookable", async () => {
      scheduler.reserveSlot("slot-1");
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("is idempotent on an already-bookable slot", async () => {
      scheduler.releaseSlot("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("throws when slot does not exist", async () => {
      expect(() => scheduler.releaseSlot("slot-unknown")).toThrow("not found");
    });
  });

  describe("Slot Bundle Reservations", () => {
    beforeEach(() => {
      // Add more slots for bundle tests
      slotRepo = new InMemorySlotRepository([
        makeSlot({ id: "slot-1" }),
        makeSlot({ id: "slot-2" }),
        makeSlot({ id: "slot-3" }),
        makeSlot({ id: "slot-4", bookable: false }),
      ]);
      scheduler = new SchedulingService(slotRepo, intentRepo);
    });

    it("reserves all slots in a bundle atomically", () => {
      scheduler.reserveBundle("bundle-1", ["slot-1", "slot-2"]);
      expect(slotRepo.findById("slot-1")!.bookable).toBe(false);
      expect(slotRepo.findById("slot-2")!.bookable).toBe(false);
    });

    it("rolls back reservation if any slot leg fails (not bookable)", () => {
      expect(() => scheduler.reserveBundle("bundle-1", ["slot-1", "slot-4"])).toThrow(
        /Failed to reserve bundle bundle-1/,
      );

      // slot-1 should have been rolled back to bookable
      expect(slotRepo.findById("slot-1")!.bookable).toBe(true);
      expect(slotRepo.findById("slot-4")!.bookable).toBe(false); // remained not bookable
    });

    it("rolls back reservation if any slot leg fails (not found)", () => {
      expect(() => scheduler.reserveBundle("bundle-1", ["slot-1", "slot-unknown"])).toThrow(
        /Failed to reserve bundle bundle-1/,
      );

      expect(slotRepo.findById("slot-1")!.bookable).toBe(true);
    });

    it("releases a previously reserved bundle", () => {
      scheduler.reserveBundle("bundle-1", ["slot-1", "slot-2"]);
      scheduler.releaseBundle("bundle-1");

      expect(slotRepo.findById("slot-1")!.bookable).toBe(true);
      expect(slotRepo.findById("slot-2")!.bookable).toBe(true);
    });

    it("throws error when releasing an unknown bundle", () => {
      expect(() => scheduler.releaseBundle("bundle-unknown")).toThrow(
        /Bundle bundle-unknown not found/,
      );
    });

    it("prevents concurrent/duplicate reservations of the same bundle", () => {
      scheduler.reserveBundle("bundle-1", ["slot-1", "slot-2"]);
      expect(() => scheduler.reserveBundle("bundle-1", ["slot-3"])).toThrow(
        /Bundle bundle-1 is already reserved/,
      );
    });

    it("handles over-count by deduplicating slotIds", () => {
      // should not fail or double-reserve (which would throw if not deduplicated)
      scheduler.reserveBundle("bundle-1", ["slot-1", "slot-1", "slot-2"]);
      expect(slotRepo.findById("slot-1")!.bookable).toBe(false);
      expect(slotRepo.findById("slot-2")!.bookable).toBe(false);

      // Release should also work without throwing
      scheduler.releaseBundle("bundle-1");
      expect(slotRepo.findById("slot-1")!.bookable).toBe(true);
      expect(slotRepo.findById("slot-2")!.bookable).toBe(true);
    });

    it("prevents reservation if tenant is paused", () => {
      scheduler.pausedTenants.add("tenant-bad");

      expect(() => scheduler.reserveBundle("bundle-1", ["slot-1", "slot-2"], "tenant-bad")).toThrow(
        /Tenant tenant-bad is paused/,
      );

      // Should still be bookable
      expect(slotRepo.findById("slot-1")!.bookable).toBe(true);
      expect(slotRepo.findById("slot-2")!.bookable).toBe(true);
    });
  });
});

// ─── BookingIntentService + scheduling integration ──────────────────────────

describe("BookingIntentService scheduling integration", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let service: BookingIntentService;

  beforeEach(() => {
    slotRepo = new InMemorySlotRepository([makeSlot()]);
    intentRepo = new InMemoryBookingIntentRepository();
    service = new BookingIntentService(intentRepo, slotRepo);
  });

  describe("createIntent", () => {
    it("reserves the slot on intent creation", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("rejects creation when slot is already reserved", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      await expect(service.createIntent({ slotId: "slot-1" }, other)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("rejects creation on a non-bookable slot", async () => {
      slotRepo.updateBookable("slot-1", false);
      await expect(service.createIntent({ slotId: "slot-1" }, actor)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("rejects creation when slot does not exist", async () => {
      await expect(service.createIntent({ slotId: "slot-missing" }, actor)).rejects.toThrow(
        /not found/,
      );
    });

    it("rejects duplicate intent by same customer on same slot", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      await expect(service.createIntent({ slotId: "slot-1" }, actor)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("allows another customer after cancel + release", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      const second = await service.createIntent({ slotId: "slot-1" }, other);
      expect(second.slotId).toBe("slot-1");
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(false);
    });

    it("allows another customer after expire + release", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.expireIntent(intent.id);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      const second = await service.createIntent({ slotId: "slot-1" }, other);
      expect(second.slotId).toBe("slot-1");
    });
  });

  describe("cancelIntent", () => {
    it("releases the slot back to bookable", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to cancelled", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const cancelled = service.cancelIntent(intent.id, actor);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation by non-owner non-admin", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const other = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      expect(() => service.cancelIntent(intent.id, other)).toThrow(/not authorized/);
    });

    it("allows admin to cancel any intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const cancelled = service.cancelIntent(intent.id, admin);
      expect(cancelled.status).toBe("cancelled");
    });

    it("rejects cancellation of non-pending intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      expect(() => service.cancelIntent(intent.id, actor)).toThrow(/Cannot cancel/);
    });

    it("rejects cancellation of a non-existent intent", async () => {
      expect(() => service.cancelIntent("intent-unknown", actor)).toThrow(/not found/);
    });
  });

  describe("expireIntent", () => {
    it("releases the slot back to bookable", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.expireIntent(intent.id);
      const slot = slotRepo.findById("slot-1")!;
      expect(slot.bookable).toBe(true);
    });

    it("updates intent status to expired", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      const expired = service.expireIntent(intent.id);
      expect(expired.status).toBe("expired");
    });

    it("rejects expiry of non-pending intent", async () => {
      const intent = await service.createIntent({ slotId: "slot-1" }, actor);
      service.cancelIntent(intent.id, actor);
      expect(() => service.expireIntent(intent.id)).toThrow(/Cannot expire/);
    });

    it("rejects expiry of non-existent intent", async () => {
      expect(() => service.expireIntent("intent-unknown")).toThrow(/not found/);
    });
  });

  describe("double-booking prevention (concurrent intents)", () => {
    it("prevents two customers from booking the same slot", async () => {
      await service.createIntent({ slotId: "slot-1" }, actor);
      const second = { userId: "customer-2", role: "customer" as const, claims: {} as any };
      await expect(service.createIntent({ slotId: "slot-1" }, second)).rejects.toThrow(
        /not bookable/,
      );
    });

    it("prevents a second intent after the first is cancelled", async () => {
      const intent = await service.createIntent(
        { slotId: "slot-1" },
        { userId: "customer-1", role: "customer" as const, claims: {} as any },
      );
      service.cancelIntent(intent.id, {
        userId: "customer-1",
        role: "customer" as const,
        claims: {} as any,
      });
      const second = await service.createIntent(
        { slotId: "slot-1" },
        { userId: "customer-2", role: "customer" as const, claims: {} as any },
      );
      expect(second.slotId).toBe("slot-1");
    });
  });
});

// ─── Repository-level edge cases ────────────────────────────────────────────

describe("InMemoryBookingIntentRepository edge cases", () => {
  it("updateStatus throws on non-existent intent", async () => {
    const repo = new InMemoryBookingIntentRepository();
    expect(() => repo.updateStatus("non-existent", "cancelled")).toThrow(/not found/);
  });

  it("findBySlotId only returns pending intents", async () => {
    const repo = new InMemoryBookingIntentRepository();
    const created = await repo.create({
      slotId: "slot-1",
      professional: "alice",
      customerId: "c1",
      startTime: 1_000,
      endTime: 2_000,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    expect(repo.findBySlotId("slot-1")).toBeDefined();
    repo.updateStatus(created.id, "cancelled");
    expect(repo.findBySlotId("slot-1")).toBeUndefined();
  });
});

describe("InMemorySlotRepository edge cases", () => {
  it("updateBookable throws on non-existent slot", async () => {
    const repo = new InMemorySlotRepository([]);
    expect(() => repo.updateBookable("no-slot", true)).toThrow(/not found/);
  });

  it("list returns copies of all slots", async () => {
    const repo = new InMemorySlotRepository([makeSlot()]);
    const all = repo.list();
    expect(all).toHaveLength(1);
    all[0]!.bookable = false;
    expect(repo.findById("slot-1")!.bookable).toBe(true);
  });

  it("findById returns undefined for missing id", async () => {
    const repo = new InMemorySlotRepository([]);
    expect(repo.findById("nope")).toBeUndefined();
  });
});

// ─── Race-condition simulation ──────────────────────────────────────────────

describe("race-condition guard", () => {
  it("simulates concurrent reserve calls — second one fails", async () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const scheduler = new SchedulingService(slotRepo, intentRepo);

    scheduler.reserveSlot("slot-1");
    expect(() => scheduler.reserveSlot("slot-1")).toThrow(SlotNotBookableError);
    const slot = slotRepo.findById("slot-1")!;
    expect(slot.bookable).toBe(false);
  });

  it("create->cancel->create cycle works correctly", async () => {
    const slotRepo = new InMemorySlotRepository([makeSlot()]);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(intentRepo, slotRepo);

    const a1 = await service.createIntent(
      { slotId: "slot-1" },
      { userId: "a", role: "customer" as const, claims: {} as any },
    );
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);

    service.cancelIntent(a1.id, { userId: "a", role: "customer" as const, claims: {} as any });
    expect(slotRepo.findById("slot-1")!.bookable).toBe(true);

    const a2 = await service.createIntent(
      { slotId: "slot-1" },
      { userId: "b", role: "customer" as const, claims: {} as any },
    );
    expect(slotRepo.findById("slot-1")!.bookable).toBe(false);
    expect(a2.customerId).toBe("b");
  });
});

// ─── Supplier pre-slot cancellation & escrow refund (issue #439) ─────────────

function makeIntentWithPricing(overrides: Partial<BookingIntentRecord> = {}): BookingIntentRecord {
  const slotStartMs = Date.now() + 48 * 60 * 60 * 1000;
  const resolvedPrice = 100_00;
  const platformFeeCents = Math.round(resolvedPrice * 0.05);
  const taxCents = Math.round(resolvedPrice * 0.08);
  const pricingSnapshot: PricingSnapshot = {
    strategyId: "flat-rate",
    resolvedPrice,
    basePrice: resolvedPrice,
    slotStartMs,
    nowMs: Date.now(),
    activeBookings: 0,
    capacity: 1,
    config: { strategy: "fixed" },
  };
  return {
    id: "intent-escrow-1",
    slotId: "slot-escrow",
    slotIds: ["slot-escrow"],
    professional: "supplier-42",
    supplierId: "supplier-42",
    customerId: "buyer-7",
    buyerId: "buyer-7",
    startTime: slotStartMs,
    endTime: slotStartMs + 3600_000,
    status: "confirmed",
    bundleId: "bundle-escrow",
    escrowHoldId: "escrow-hold-abc123",
    createdAt: new Date().toISOString(),
    pricingSnapshot: {
      ...pricingSnapshot,
      resolvedPrice,
      platformFeeCents,
      taxCents,
      currency: "USD",
    } as any,
    ...overrides,
  };
}

describe("Escrow Refund — supplier cancel before slot start (issue #439)", () => {
  let slotRepo: InMemorySlotRepository;
  let intentRepo: InMemoryBookingIntentRepository;
  let scheduler: SchedulingService;
  const NOW = Date.now();

  beforeEach(() => {
    slotRepo = new InMemorySlotRepository([
      makeSlot({ id: "slot-escrow", bookable: true }),
      makeSlot({ id: "slot-escrow-2", bookable: true }),
    ]);
    intentRepo = new InMemoryBookingIntentRepository();
    scheduler = new SchedulingService(slotRepo, intentRepo);
    scheduler._clearRefundLedger();
    refundEvents.removeAllListeners();
  });

  it("rejects cancellation AFTER slot has started", async () => {
    const startTime = NOW - 60_000;
    const intent = makeIntentWithPricing({ startTime });
    await intentRepo.create(intent);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);

    expect(() =>
      scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW }),
    ).toThrow(CancellationAfterSlotStartError);
  });

  it("rejects cancellation AT exactly the slot start time", async () => {
    const startTime = NOW;
    const intent = makeIntentWithPricing({ startTime });
    await intentRepo.create(intent);

    expect(() =>
      scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW }),
    ).toThrow(CancellationAfterSlotStartError);
  });

  it("returns 100% gross refund + full fee reversal + full tax reversal", async () => {
    const intent = makeIntentWithPricing();
    await intentRepo.create(intent);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);

    const result = scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW });

    const snap = intent.pricingSnapshot as any;
    expect(result.grossRefund).toBe(snap.resolvedPrice);
    expect(result.platformFeeReversed).toBe(snap.platformFeeCents);
    expect(result.taxReversed).toBe(snap.taxCents);
    expect(result.netRefund).toBe(snap.resolvedPrice + snap.taxCents);
  });

  it("applies fallback fee/tax defaults when pricing snapshot has no explicit fee/tax", async () => {
    const intent = makeIntentWithPricing({
      pricingSnapshot: {
        strategyId: "flat-rate",
        resolvedPrice: 50_00,
        basePrice: 50_00,
        slotStartMs: NOW + 7200_000,
        nowMs: NOW,
        activeBookings: 0,
        capacity: 1,
        config: {},
        currency: "USD",
      } as any,
    });
    await intentRepo.create(intent);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);

    const result = scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW });
    const expectedFee = Math.round(50_00 * 0.05);
    const expectedTax = Math.round(50_00 * 0.08);

    expect(result.grossRefund).toBe(50_00);
    expect(result.platformFeeReversed).toBe(expectedFee);
    expect(result.taxReversed).toBe(expectedTax);
    expect(result.netRefund).toBe(50_00 + expectedTax);
  });

  it("releases ALL reserved slots and the associated bundle", async () => {
    slotRepo = new InMemorySlotRepository([
      makeSlot({ id: "s1", bookable: true }),
      makeSlot({ id: "s2", bookable: true }),
      makeSlot({ id: "s3", bookable: true }),
    ]);
    scheduler = new SchedulingService(slotRepo, intentRepo);
    scheduler.reserveBundle("multi-slot-bundle", ["s1", "s2", "s3"]);

    const intent = makeIntentWithPricing({
      bundleId: "multi-slot-bundle",
      slotIds: ["s1", "s2", "s3"],
    });
    await intentRepo.create(intent);

    const result = scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW });

    expect(result.releasedSlots).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
    expect(slotRepo.findById("s1")!.bookable).toBe(true);
    expect(slotRepo.findById("s2")!.bookable).toBe(true);
    expect(slotRepo.findById("s3")!.bookable).toBe(true);
  });

  it("appends hash-chained ledger entries sequentially", async () => {
    const i1 = makeIntentWithPricing({ id: "i1" });
    const i2 = makeIntentWithPricing({ id: "i2", startTime: NOW + 96 * 3600_000 });
    await intentRepo.create(i1);
    await intentRepo.create(i2);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);
    scheduler.reserveBundle("bundle-escrow-2", ["slot-escrow-2"]);
    i2.bundleId = "bundle-escrow-2";
    i2.slotIds = ["slot-escrow-2"];

    const r1 = scheduler.handleSupplierCancelBeforeSlotStart("i1", { nowMs: () => NOW });
    const r2 = scheduler.handleSupplierCancelBeforeSlotStart("i2", { nowMs: () => NOW + 1000 });

    expect(r1.ledgerEntry.prevLedgerHash).toBe("");
    expect(r2.ledgerEntry.prevLedgerHash).toBe(r1.ledgerEntry.ledgerHash);

    const chain = scheduler.verifyRefundLedgerChain();
    expect(chain.valid).toBe(true);
    expect(chain.firstBrokenIndex).toBe(-1);
    expect(chain.entriesChecked).toBe(2);
  });

  it("deriveRefundLedgerHash produces deterministic output for identical inputs", () => {
    const iso = "2026-01-01T00:00:00.000Z";
    const a = deriveRefundLedgerHash("r1", "", 100, 5, 8, 108, iso);
    const b = deriveRefundLedgerHash("r1", "", 100, 5, 8, 108, iso);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const c = deriveRefundLedgerHash("r1", "", 100, 5, 8, 108, "2026-01-01T00:00:01.000Z");
    expect(c).not.toBe(a);
  });

  it("verifyRefundLedgerChain detects a tampered prevLedgerHash", async () => {
    const i1 = makeIntentWithPricing({ id: "tamper1" });
    const i2 = makeIntentWithPricing({ id: "tamper2" });
    await intentRepo.create(i1);
    await intentRepo.create(i2);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);

    scheduler.handleSupplierCancelBeforeSlotStart("tamper1", { nowMs: () => NOW });
    scheduler.handleSupplierCancelBeforeSlotStart("tamper2", { nowMs: () => NOW + 1000 });

    expect(scheduler.verifyRefundLedgerChain().valid).toBe(true);

    const entry2 = scheduler.findRefundsByIntentId("tamper2")[0];
    entry2.prevLedgerHash = "0000000000000000000000000000000000000000000000000000000000000000";

    const report = scheduler.verifyRefundLedgerChain();
    expect(report.valid).toBe(false);
    expect(report.firstBrokenIndex).toBe(1);
  });

  it("emits refund.requested event with ledger details", async () => {
    const intent = makeIntentWithPricing();
    await intentRepo.create(intent);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);

    let emitted: any = null;
    refundEvents.on("refund.requested", (payload) => {
      emitted = payload;
    });

    const result = scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW });

    expect(emitted).not.toBeNull();
    expect(emitted.refundRequestId).toBe(result.refundRequestId);
    expect(emitted.bookingIntentId).toBe(intent.id);
    expect(emitted.ledgerEntry.escrowHoldId).toBe("escrow-hold-abc123");
  });

  it("markRefundSettled transitions ledger status to completed with chainTxId", async () => {
    const intent = makeIntentWithPricing();
    await intentRepo.create(intent);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);
    const result = scheduler.handleSupplierCancelBeforeSlotStart(intent.id, { nowMs: () => NOW });

    const settled = scheduler.markRefundSettled(result.refundRequestId, "chain-tx-xyz789");

    expect(settled.status).toBe("completed");
    expect(settled.chainTxId).toBe("chain-tx-xyz789");
    const lookup = scheduler.findRefundByRequestId(result.refundRequestId);
    expect(lookup?.status).toBe("completed");
    expect(lookup?.chainTxId).toBe("chain-tx-xyz789");
  });

  it("markRefundSettled throws EscrowRefundLedgerIntegrityError for unknown id", () => {
    expect(() => scheduler.markRefundSettled("does-not-exist", "tx-hash")).toThrow(
      EscrowRefundLedgerIntegrityError,
    );
  });

  it("findRefundByRequestId and findRefundsByIntentId return correct results", async () => {
    const i1 = makeIntentWithPricing({ id: "rfi1" });
    await intentRepo.create(i1);
    scheduler.reserveBundle("bundle-escrow", ["slot-escrow"]);
    const result = scheduler.handleSupplierCancelBeforeSlotStart("rfi1", { nowMs: () => NOW });

    expect(scheduler.findRefundByRequestId(result.refundRequestId)?.refundRequestId).toBe(
      result.refundRequestId,
    );
    expect(scheduler.findRefundsByIntentId("rfi1")).toHaveLength(1);
    expect(scheduler.findRefundsByIntentId("nonexistent")).toEqual([]);
    expect(scheduler.findRefundByRequestId("nope")).toBeUndefined();
  });

  it("ledger stores hoursBeforeStart correctly for various windows", async () => {
    const cases = [
      { hoursAhead: 0.5, label: "30 mins" },
      { hoursAhead: 2, label: "2 hours" },
      { hoursAhead: 24 * 7, label: "7 days" },
    ];

    for (const c of cases) {
      const startTime = NOW + c.hoursAhead * 3_600_000;
      const intent = makeIntentWithPricing({
        id: `window-${c.label}`,
        startTime,
      });
      await intentRepo.create(intent);
      const localScheduler = new SchedulingService(slotRepo, intentRepo);
      const result = localScheduler.handleSupplierCancelBeforeSlotStart(intent.id, {
        nowMs: () => NOW,
      });
      const diff = Math.abs(result.ledgerEntry.hoursBeforeStart - c.hoursAhead);
      expect(diff).toBeLessThan(0.001);
      localScheduler._clearRefundLedger();
    }
  });
});

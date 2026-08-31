import { jest } from "@jest/globals";
import {
  SubscriptionService,
  SubscriptionProductNotFoundError,
  SubscriptionNotFoundError,
  DuplicateSubscriptionError,
  SubscriptionCapacityExceededError,
  InvalidSubscriptionStateError,
  SchedulingConflictError,
  expandRecurrence,
} from "../subscriptionService.js";
import { InMemorySubscriptionProductRepository } from "../../modules/subscriptions/subscription-product-repository.js";
import { InMemorySubscriptionRepository } from "../../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository } from "../../modules/slots/slot-repository.js";

describe("SubscriptionService", () => {
  let productRepo: InMemorySubscriptionProductRepository;
  let subscriptionRepo: InMemorySubscriptionRepository;
  let slotRepo: InMemorySlotRepository;
  let service: SubscriptionService;

  beforeEach(() => {
    productRepo = new InMemorySubscriptionProductRepository();
    subscriptionRepo = new InMemorySubscriptionRepository();
    slotRepo = new InMemorySlotRepository();
    service = new SubscriptionService(productRepo, subscriptionRepo, slotRepo);
  });

  function createTestProduct(overrides: Record<string, unknown> = {}) {
    return service.createProduct({
      name: "Weekly Yoga",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      timezone: "America/New_York",
      priceCents: 2500,
      currency: "USD",
      ...overrides,
    });
  }

  // ── Product Tests ────────────────────────────────────────────────────────

  describe("createProduct", () => {
    it("creates a product with valid input", () => {
      const product = createTestProduct();
      expect(product.id).toBeDefined();
      expect(product.name).toBe("Weekly Yoga");
      expect(product.professional).toBe("alice");
      expect(product.active).toBe(true);
    });

    it("throws on missing name", () => {
      expect(() =>
        service.createProduct({
          name: "",
          professional: "alice",
          slotDurationMs: 3_600_000,
          recurrenceRule: "FREQ=DAILY",
        }),
      ).toThrow("name is required");
    });

    it("throws on missing professional", () => {
      expect(() =>
        service.createProduct({
          name: "Test",
          professional: "",
          slotDurationMs: 3_600_000,
          recurrenceRule: "FREQ=DAILY",
        }),
      ).toThrow("Professional is required");
    });

    it("throws on non-positive slotDurationMs", () => {
      expect(() =>
        service.createProduct({
          name: "Test",
          professional: "alice",
          slotDurationMs: 0,
          recurrenceRule: "FREQ=DAILY",
        }),
      ).toThrow("slotDurationMs must be positive");
    });

    it("throws on missing recurrenceRule", () => {
      expect(() =>
        service.createProduct({
          name: "Test",
          professional: "alice",
          slotDurationMs: 3_600_000,
          recurrenceRule: "",
        }),
      ).toThrow("recurrenceRule is required");
    });

    it("throws on negative priceCents", () => {
      expect(() =>
        service.createProduct({
          name: "Test",
          professional: "alice",
          slotDurationMs: 3_600_000,
          recurrenceRule: "FREQ=DAILY",
          priceCents: -100,
        }),
      ).toThrow("priceCents must be non-negative");
    });

    it("uses default values", () => {
      const product = createTestProduct({ timezone: undefined, priceCents: undefined, currency: undefined });
      expect(product.timezone).toBe("UTC");
      expect(product.priceCents).toBe(0);
      expect(product.currency).toBe("USD");
    });
  });

  describe("getProduct", () => {
    it("returns an existing product", () => {
      const product = createTestProduct();
      const found = service.getProduct(product.id);
      expect(found.id).toBe(product.id);
    });

    it("throws for unknown product", () => {
      expect(() => service.getProduct("nonexistent")).toThrow(SubscriptionProductNotFoundError);
    });
  });

  describe("deactivateProduct", () => {
    it("deactivates an active product", () => {
      const product = createTestProduct();
      const deactivated = service.deactivateProduct(product.id);
      expect(deactivated.active).toBe(false);
    });

    it("throws for unknown product", () => {
      expect(() => service.deactivateProduct("nonexistent")).toThrow(SubscriptionProductNotFoundError);
    });
  });

  // ── Subscription Tests ──────────────────────────────────────────────────

  describe("subscribe", () => {
    it("creates a subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      expect(sub.id).toBeDefined();
      expect(sub.productId).toBe(product.id);
      expect(sub.subscriberId).toBe("user-1");
      expect(sub.status).toBe("active");
      expect(sub.slotsMinted).toBe(0);
    });

    it("throws for unknown product", () => {
      expect(() =>
        service.subscribe({ productId: "nonexistent", subscriberId: "user-1" }),
      ).toThrow(SubscriptionProductNotFoundError);
    });

    it("throws for inactive product", () => {
      const product = createTestProduct();
      service.deactivateProduct(product.id);
      expect(() =>
        service.subscribe({ productId: product.id, subscriberId: "user-1" }),
      ).toThrow("not active");
    });

    it("throws for duplicate subscription", () => {
      const product = createTestProduct();
      service.subscribe({ productId: product.id, subscriberId: "user-1" });
      expect(() =>
        service.subscribe({ productId: product.id, subscriberId: "user-1" }),
      ).toThrow(DuplicateSubscriptionError);
    });

    it("throws when capacity exceeded", () => {
      const product = createTestProduct({ maxSubscribers: 1 });
      service.subscribe({ productId: product.id, subscriberId: "user-1" });
      expect(() =>
        service.subscribe({ productId: product.id, subscriberId: "user-2" }),
      ).toThrow(SubscriptionCapacityExceededError);
    });

    it("allows subscribe after cancel", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.cancelSubscription(sub.id);
      const sub2 = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      expect(sub2.id).not.toBe(sub.id);
      expect(sub2.status).toBe("active");
    });
  });

  describe("pauseSubscription", () => {
    it("pauses an active subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      const paused = service.pauseSubscription(sub.id);
      expect(paused.status).toBe("paused");
      expect(paused.pausedAt).toBeDefined();
    });

    it("throws for unknown subscription", () => {
      expect(() => service.pauseSubscription("nonexistent")).toThrow(SubscriptionNotFoundError);
    });

    it("throws for already paused subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.pauseSubscription(sub.id);
      expect(() => service.pauseSubscription(sub.id)).toThrow(InvalidSubscriptionStateError);
    });

    it("throws for cancelled subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.cancelSubscription(sub.id);
      expect(() => service.pauseSubscription(sub.id)).toThrow(InvalidSubscriptionStateError);
    });
  });

  describe("resumeSubscription", () => {
    it("resumes a paused subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.pauseSubscription(sub.id);
      const resumed = service.resumeSubscription(sub.id);
      expect(resumed.status).toBe("active");
      expect(resumed.pausedAt).toBeNull();
    });

    it("throws for active subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      expect(() => service.resumeSubscription(sub.id)).toThrow(InvalidSubscriptionStateError);
    });

    it("throws for cancelled subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.cancelSubscription(sub.id);
      expect(() => service.resumeSubscription(sub.id)).toThrow(InvalidSubscriptionStateError);
    });
  });

  describe("cancelSubscription", () => {
    it("cancels an active subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      const cancelled = service.cancelSubscription(sub.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancelledAt).toBeDefined();
    });

    it("cancels a paused subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.pauseSubscription(sub.id);
      const cancelled = service.cancelSubscription(sub.id);
      expect(cancelled.status).toBe("cancelled");
    });

    it("throws for already cancelled subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      service.cancelSubscription(sub.id);
      expect(() => service.cancelSubscription(sub.id)).toThrow(InvalidSubscriptionStateError);
    });

    it("throws for unknown subscription", () => {
      expect(() => service.cancelSubscription("nonexistent")).toThrow(SubscriptionNotFoundError);
    });
  });

  // ── Slot Generation Tests ───────────────────────────────────────────────

  describe("mintSlot", () => {
    it("mints a slot for an active subscription", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });
      const result = service.mintSlot(sub);

      expect(result.subscriptionId).toBe(sub.id);
      expect(result.slotId).toBeDefined();
      expect(result.professional).toBe("alice");
      expect(result.startTime).toBe(sub.nextSlotStartMs);
      expect(result.endTime).toBe(sub.nextSlotStartMs + product.slotDurationMs);
      expect(result.nextSlotStartMs).toBeGreaterThan(sub.nextSlotStartMs);
    });

    it("throws on scheduling conflict", () => {
      const product = createTestProduct();
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });

      // Create a conflicting slot
      slotRepo.hasConflict = () => true;

      expect(() => service.mintSlot(sub)).toThrow(SchedulingConflictError);
    });
  });

  describe("generateSlotsForDueSubscriptions", () => {
    it("processes due subscriptions and mints slots", () => {
      const product = createTestProduct({ recurrenceRule: "FREQ=DAILY" });
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });

      const result = service.generateSlotsForDueSubscriptions(Date.now() + 100_000);
      expect(result.processed).toBe(1);
      expect(result.minted).toHaveLength(1);
      expect(result.minted[0].subscriptionId).toBe(sub.id);
    });

    it("skips subscriptions not yet due", () => {
      const product = createTestProduct();
      service.subscribe({ productId: product.id, subscriberId: "user-1" });

      const result = service.generateSlotsForDueSubscriptions(0); // far in the past
      expect(result.processed).toBe(0);
      expect(result.minted).toHaveLength(0);
    });

    it("handles conflicts gracefully", () => {
      const product = createTestProduct({ recurrenceRule: "FREQ=DAILY" });
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });

      // Make conflict detection always return true
      slotRepo.hasConflict = () => true;

      const result = service.generateSlotsForDueSubscriptions(Date.now() + 100_000);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toBe(sub.id);
    });

    it("is idempotent across multiple runs", () => {
      const product = createTestProduct({ recurrenceRule: "FREQ=DAILY" });
      const sub = service.subscribe({ productId: product.id, subscriberId: "user-1" });

      // Run twice at the same time
      const result1 = service.generateSlotsForDueSubscriptions(Date.now() + 100_000);
      const result2 = service.generateSlotsForDueSubscriptions(Date.now() + 100_000);

      // Only first run should mint (cursor advances after first)
      expect(result1.minted).toHaveLength(1);
      // Second run should not have anything due (cursor advanced past it)
      expect(result2.minted).toHaveLength(0);
    });
  });
});

describe("expandRecurrence", () => {
  const DAY_MS = 86_400_000;

  it("expands daily recurrence", () => {
    const startMs = Date.UTC(2026, 0, 1); // Jan 1
    const slots = expandRecurrence("FREQ=DAILY", startMs, 3_600_000, DAY_MS * 3);
    expect(slots).toHaveLength(3);
    expect(slots[0].startMs).toBe(startMs);
    expect(slots[1].startMs).toBe(startMs + DAY_MS);
    expect(slots[2].startMs).toBe(startMs + 2 * DAY_MS);
  });

  it("expands daily recurrence with interval", () => {
    const startMs = Date.UTC(2026, 0, 1);
    const slots = expandRecurrence("FREQ=DAILY;INTERVAL=2", startMs, 3_600_000, DAY_MS * 7);
    expect(slots).toHaveLength(4); // day 0, 2, 4, 6
  });

  it("expands weekly recurrence", () => {
    const startMs = Date.UTC(2026, 0, 5); // Monday
    const slots = expandRecurrence("FREQ=WEEKLY", startMs, 3_600_000, DAY_MS * 22);
    expect(slots).toHaveLength(4); // weeks 0, 1, 2, 3
  });

  it("expands with BYDAY filter", () => {
    const startMs = Date.UTC(2026, 0, 5); // Monday
    const slots = expandRecurrence("FREQ=WEEKLY;BYDAY=MO", startMs, 3_600_000, DAY_MS * 22);
    expect(slots).toHaveLength(4); // weeks 0, 1, 2, 3
  });

  it("respects COUNT limit", () => {
    const startMs = Date.UTC(2026, 0, 1);
    const slots = expandRecurrence("FREQ=DAILY;COUNT=2", startMs, 3_600_000, DAY_MS * 10);
    expect(slots).toHaveLength(2);
  });

  it("returns empty for zero horizon", () => {
    const startMs = Date.UTC(2026, 0, 1);
    const slots = expandRecurrence("FREQ=DAILY", startMs, 3_600_000, 0);
    expect(slots).toHaveLength(0);
  });

  it("each slot has correct duration", () => {
    const startMs = Date.UTC(2026, 0, 1);
    const duration = 7_200_000; // 2 hours
    const slots = expandRecurrence("FREQ=DAILY", startMs, duration, DAY_MS * 2);
    for (const slot of slots) {
      expect(slot.endMs - slot.startMs).toBe(duration);
    }
  });
});

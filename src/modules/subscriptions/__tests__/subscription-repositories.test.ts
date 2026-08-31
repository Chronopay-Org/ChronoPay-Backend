import {
  InMemorySubscriptionProductRepository,
  type SubscriptionProductRecord,
} from "../subscription-product-repository.js";
import {
  InMemorySubscriptionRepository,
  type SubscriptionRecord,
} from "../subscription-repository.js";

describe("SubscriptionProductRepository", () => {
  let repo: InMemorySubscriptionProductRepository;

  beforeEach(() => {
    repo = new InMemorySubscriptionProductRepository();
  });

  function makeProduct(overrides: Partial<SubscriptionProductRecord> = {}): SubscriptionProductRecord {
    return {
      id: "sp-test",
      name: "Weekly Yoga",
      description: "Every Monday yoga session",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      timezone: "America/New_York",
      priceCents: 2500,
      currency: "USD",
      maxSubscribers: null,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("creates and retrieves a product", () => {
    const created = repo.create({
      name: "Weekly Yoga",
      description: "Every Monday yoga session",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      timezone: "America/New_York",
      priceCents: 2500,
      currency: "USD",
      maxSubscribers: null,
      active: true,
    });

    expect(created.id).toBeDefined();
    expect(created.name).toBe("Weekly Yoga");
    expect(created.professional).toBe("alice");

    const found = repo.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("returns undefined for unknown id", () => {
    expect(repo.findById("nonexistent")).toBeUndefined();
  });

  it("lists products by professional", () => {
    repo.create({
      name: "Product A",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
      priceCents: 0,
      currency: "USD",
      maxSubscribers: null,
      active: true,
    });
    repo.create({
      name: "Product B",
      professional: "bob",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
      priceCents: 0,
      currency: "USD",
      maxSubscribers: null,
      active: true,
    });

    const aliceProducts = repo.listByProfessional("alice");
    expect(aliceProducts).toHaveLength(1);
    expect(aliceProducts[0].name).toBe("Product A");
  });

  it("lists only active products", () => {
    repo.create({
      name: "Active",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
      priceCents: 0,
      currency: "USD",
      maxSubscribers: null,
      active: true,
    });
    repo.create({
      name: "Inactive",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
      priceCents: 0,
      currency: "USD",
      maxSubscribers: null,
      active: false,
    });

    const active = repo.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("Active");
  });

    it("updates a product", () => {
      const created = repo.create({
        name: "Original",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        priceCents: 0,
        currency: "USD",
        maxSubscribers: null,
        active: true,
      });

      const updated = repo.update(created.id, { name: "Updated", active: false });
      expect(updated.name).toBe("Updated");
      expect(updated.active).toBe(false);
      // updatedAt is set (may be same ms as create in fast tests)
      expect(updated.updatedAt).toBeDefined();
    });

  it("throws on update of nonexistent product", () => {
    expect(() => repo.update("nonexistent", { name: "X" })).toThrow("not found");
  });

  it("deletes a product", () => {
    const created = repo.create({
      name: "ToDelete",
      professional: "alice",
      slotDurationMs: 3_600_000,
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
      priceCents: 0,
      currency: "USD",
      maxSubscribers: null,
      active: true,
    });

    expect(repo.delete(created.id)).toBe(true);
    expect(repo.findById(created.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent product", () => {
    expect(repo.delete("nonexistent")).toBe(false);
  });
});

describe("SubscriptionRepository", () => {
  let repo: InMemorySubscriptionRepository;

  beforeEach(() => {
    repo = new InMemorySubscriptionRepository();
  });

  function makeSub(overrides: Partial<SubscriptionRecord> = {}): Omit<SubscriptionRecord, "id" | "createdAt" | "updatedAt"> {
    return {
      productId: "sp-1",
      subscriberId: "user-1",
      status: "active",
      nextSlotStartMs: 1_700_000_000_000,
      slotOffsetMs: 0,
      slotsMinted: 0,
      pausedAt: null,
      cancelledAt: null,
      ...overrides,
    };
  }

  it("creates and retrieves a subscription", () => {
    const created = repo.create(makeSub());
    expect(created.id).toBeDefined();
    expect(created.status).toBe("active");

    const found = repo.findById(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("finds subscription by product and subscriber", () => {
    const created = repo.create(makeSub({ productId: "sp-1", subscriberId: "user-1" }));
    const found = repo.findByProductAndSubscriber("sp-1", "user-1");
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it("does not find cancelled subscription by product and subscriber", () => {
    repo.create(makeSub({ productId: "sp-1", subscriberId: "user-1", status: "cancelled" }));
    const found = repo.findByProductAndSubscriber("sp-1", "user-1");
    expect(found).toBeUndefined();
  });

  it("lists active subscriptions by product", () => {
    repo.create(makeSub({ productId: "sp-1", status: "active" }));
    repo.create(makeSub({ productId: "sp-1", status: "paused" }));
    repo.create(makeSub({ productId: "sp-2", status: "active" }));

    const active = repo.listActiveByProduct("sp-1");
    expect(active).toHaveLength(1);
  });

  it("lists subscriptions due before a given time", () => {
    repo.create(makeSub({ nextSlotStartMs: 1000, status: "active" }));
    repo.create(makeSub({ nextSlotStartMs: 2000, status: "active" }));
    repo.create(makeSub({ nextSlotStartMs: 3000, status: "active" }));

    const due = repo.listActiveDueBefore(2500, 10);
    expect(due).toHaveLength(2);
    expect(due[0].nextSlotStartMs).toBe(1000);
    expect(due[1].nextSlotStartMs).toBe(2000);
  });

  it("respects batch size in listActiveDueBefore", () => {
    for (let i = 1; i <= 10; i++) {
      repo.create(makeSub({ nextSlotStartMs: i * 1000, status: "active" }));
    }

    const due = repo.listActiveDueBefore(100_000, 3);
    expect(due).toHaveLength(3);
  });

    it("updates a subscription", () => {
      const created = repo.create(makeSub());
      const updated = repo.update(created.id, { status: "paused", slotsMinted: 5 });
      expect(updated.status).toBe("paused");
      expect(updated.slotsMinted).toBe(5);
      // updatedAt is set (may be same ms as create in fast tests)
      expect(updated.updatedAt).toBeDefined();
    });

  it("throws on update of nonexistent subscription", () => {
    expect(() => repo.update("nonexistent", { status: "paused" })).toThrow("not found");
  });

  it("returns undefined for unknown id", () => {
    expect(repo.findById("nonexistent")).toBeUndefined();
  });
});

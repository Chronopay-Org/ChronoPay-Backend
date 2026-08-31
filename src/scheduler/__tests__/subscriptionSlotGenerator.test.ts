import { jest } from "@jest/globals";
import {
  SubscriptionSlotGenerator,
  createSubscriptionSlotGenerator,
} from "../subscriptionSlotGenerator.js";
import {
  SubscriptionService,
} from "../../services/subscriptionService.js";
import { InMemorySubscriptionProductRepository } from "../../modules/subscriptions/subscription-product-repository.js";
import { InMemorySubscriptionRepository } from "../../modules/subscriptions/subscription-repository.js";
import { InMemorySlotRepository } from "../../modules/slots/slot-repository.js";

describe("SubscriptionSlotGenerator", () => {
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

  describe("runOnce", () => {
    it("mints slots for due subscriptions", () => {
      const product = service.createProduct({
        name: "Daily Slot",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        priceCents: 0,
        currency: "USD",
        maxSubscribers: null,
        active: true,
      });

      // Create subscription due now
      subscriptionRepo.create({
        productId: product.id,
        subscriberId: "user-1",
        status: "active",
        nextSlotStartMs: Date.now() - 1000, // already due
        slotOffsetMs: 0,
        slotsMinted: 0,
        pausedAt: null,
        cancelledAt: null,
      });

      const generator = createSubscriptionSlotGenerator(service, { batchSize: 10 });
      const result = generator.runOnce();

      expect(result.processed).toBe(1);
      expect(result.minted).toHaveLength(1);
      expect(result.minted[0].professional).toBe("alice");
    });

    it("skips subscriptions not yet due", () => {
      const product = service.createProduct({
        name: "Daily Slot",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        priceCents: 0,
        currency: "USD",
        maxSubscribers: null,
        active: true,
      });

      subscriptionRepo.create({
        productId: product.id,
        subscriberId: "user-1",
        status: "active",
        nextSlotStartMs: Date.now() + 86_400_000, // tomorrow
        slotOffsetMs: 0,
        slotsMinted: 0,
        pausedAt: null,
        cancelledAt: null,
      });

      const generator = createSubscriptionSlotGenerator(service, { batchSize: 10 });
      const result = generator.runOnce();

      expect(result.processed).toBe(0);
      expect(result.minted).toHaveLength(0);
    });

    it("is idempotent across multiple runs", () => {
      const product = service.createProduct({
        name: "Daily Slot",
        professional: "alice",
        slotDurationMs: 3_600_000,
        recurrenceRule: "FREQ=DAILY",
        timezone: "UTC",
        priceCents: 0,
        currency: "USD",
        maxSubscribers: null,
        active: true,
      });

      subscriptionRepo.create({
        productId: product.id,
        subscriberId: "user-1",
        status: "active",
        nextSlotStartMs: Date.now() - 1000,
        slotOffsetMs: 0,
        slotsMinted: 0,
        pausedAt: null,
        cancelledAt: null,
      });

      const generator = createSubscriptionSlotGenerator(service, { batchSize: 10 });

      const result1 = generator.runOnce();
      expect(result1.minted).toHaveLength(1);

      const result2 = generator.runOnce();
      // Should not mint again — cursor advanced past the slot
      expect(result2.minted).toHaveLength(0);
    });
  });

  describe("start/stop lifecycle", () => {
    it("starts and stops cleanly", async () => {
      const generator = createSubscriptionSlotGenerator(service, {
        intervalMs: 50,
        maxRuns: 1,
      });

      expect(generator.isActive()).toBe(false);

      generator.start();
      expect(generator.isActive()).toBe(true);

      // Wait for it to run and auto-stop
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(generator.isActive()).toBe(false);
      expect(generator.getRunCount()).toBe(1);
    });

    it("stop prevents further ticks", async () => {
      const generator = createSubscriptionSlotGenerator(service, {
        intervalMs: 50,
      });

      generator.start();
      generator.stop();

      expect(generator.isActive()).toBe(false);

      // Wait and verify no more runs
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(generator.getRunCount()).toBe(0);
    });
  });

  describe("createSubscriptionSlotGenerator", () => {
    it("creates a generator with default config", () => {
      const generator = createSubscriptionSlotGenerator(service);
      expect(generator).toBeInstanceOf(SubscriptionSlotGenerator);
      expect(generator.isActive()).toBe(false);
    });
  });
});

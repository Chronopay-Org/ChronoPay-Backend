import type {
  SubscriptionProductRepository,
  SubscriptionProductRecord,
} from "../modules/subscriptions/subscription-product-repository.js";
import type {
  SubscriptionRepository,
  SubscriptionRecord,
  SubscriptionStatus,
} from "../modules/subscriptions/subscription-repository.js";
import type { SlotRepository } from "../modules/slots/slot-repository.js";
import { SchedulingService } from "./schedulingService.js";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class SubscriptionProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`Subscription product ${productId} not found`);
    this.name = "SubscriptionProductNotFoundError";
  }
}

export class SubscriptionNotFoundError extends Error {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} not found`);
    this.name = "SubscriptionNotFoundError";
  }
}

export class DuplicateSubscriptionError extends Error {
  constructor(productId: string, subscriberId: string) {
    super(`Subscriber ${subscriberId} already has an active/paused subscription to product ${productId}`);
    this.name = "DuplicateSubscriptionError";
  }
}

export class SubscriptionCapacityExceededError extends Error {
  constructor(productId: string) {
    super(`Subscription product ${productId} has reached its max subscriber limit`);
    this.name = "SubscriptionCapacityExceededError";
  }
}

export class InvalidSubscriptionStateError extends Error {
  constructor(subscriptionId: string, currentStatus: SubscriptionStatus, targetStatus: SubscriptionStatus) {
    super(`Cannot transition subscription ${subscriptionId} from ${currentStatus} to ${targetStatus}`);
    this.name = "InvalidSubscriptionStateError";
  }
}

export class SchedulingConflictError extends Error {
  constructor(subscriptionId: string, professional: string, startTime: number, endTime: number) {
    super(
      `Scheduling conflict for subscription ${subscriptionId}: professional ${professional} already has a slot at ${new Date(startTime).toISOString()}-${new Date(endTime).toISOString()}`,
    );
    this.name = "SchedulingConflictError";
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CreateProductInput {
  name: string;
  description?: string;
  professional: string;
  slotDurationMs: number;
  recurrenceRule: string;
  timezone?: string;
  priceCents?: number;
  currency?: string;
  maxSubscribers?: number;
}

export interface SubscribeInput {
  productId: string;
  subscriberId: string;
  slotOffsetMs?: number;
}

export interface MintResult {
  subscriptionId: string;
  slotId: string;
  professional: string;
  startTime: number;
  endTime: number;
  nextSlotStartMs: number;
}

export interface GenerateSlotsResult {
  processed: number;
  minted: MintResult[];
  skipped: number;
  conflicts: string[];
}

// ─── RRULE expansion helper ──────────────────────────────────────────────────

/**
 * Expand a simple recurrence rule to produce concrete timestamps.
 *
 * Supports a subset of RRULE syntax:
 *   - INTERVAL=<n> (days between recurrences, default 1)
 *   - COUNT=<n> (max occurrences, default: unbounded)
 *   - BYDAY=<day> (e.g. MO, TU, WE, TH, FR, SA, SU)
 *   - FREQ=DAILY | WEEKLY
 *
 * This is intentionally minimal — a production system would use a full
 * RRULE library (e.g. rrule.js).
 */
export function expandRecurrence(
  recurrenceRule: string,
  startMs: number,
  slotDurationMs: number,
  horizonMs: number,
): Array<{ startMs: number; endMs: number }> {
  const slots: Array<{ startMs: number; endMs: number }> = [];
  const upper = recurrenceRule.toUpperCase();

  // Parse INTERVAL
  const intervalMatch = upper.match(/INTERVAL=(\d+)/);
  const intervalDays = intervalMatch ? parseInt(intervalMatch[1], 10) : 1;

  // Parse COUNT
  const countMatch = upper.match(/COUNT=(\d+)/);
  const maxCount = countMatch ? parseInt(countMatch[1], 10) : Infinity;

  // Parse FREQ
  const freqMatch = upper.match(/FREQ=(DAILY|WEEKLY|MONTHLY)/);
  const freq = freqMatch ? freqMatch[1] : "DAILY";

  // Parse BYDAY
  const byDayMatch = upper.match(/BYDAY=([A-Z,]+)/);
  const byDays = byDayMatch
    ? byDayMatch[1].split(",").map((d) => d.trim())
    : [];

  const DAY_MS = 86_400_000;
  let current = startMs;
  let count = 0;
  const horizonEnd = startMs + horizonMs;

  while (current < horizonEnd && count < maxCount) {
    const endMs = current + slotDurationMs;

    if (freq === "DAILY" || freq === "WEEKLY") {
      if (byDays.length > 0) {
        const date = new Date(current);
        const dayMap: Record<string, number> = {
          SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
        };
        const dayNum = date.getUTCDay();
        const dayName = Object.entries(dayMap).find(([, v]) => v === dayNum)?.[0];
        if (dayName && byDays.includes(dayName)) {
          slots.push({ startMs: current, endMs });
          count++;
        }
      } else {
        slots.push({ startMs: current, endMs });
        count++;
      }
    }

    // Advance cursor
    if (freq === "WEEKLY") {
      current += intervalDays * 7 * DAY_MS;
    } else {
      current += intervalDays * DAY_MS;
    }
  }

  return slots;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class SubscriptionService {
  private readonly schedulingService: SchedulingService;

  constructor(
    private readonly productRepo: SubscriptionProductRepository,
    private readonly subscriptionRepo: SubscriptionRepository,
    private readonly slotRepo: SlotRepository,
    schedulingService?: SchedulingService,
  ) {
    this.schedulingService = schedulingService ?? new SchedulingService(slotRepo, {} as any);
  }

  // ── Product Management ───────────────────────────────────────────────────

  createProduct(input: CreateProductInput): SubscriptionProductRecord {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("Product name is required");
    }
    if (!input.professional || input.professional.trim().length === 0) {
      throw new Error("Professional is required");
    }
    if (input.slotDurationMs <= 0) {
      throw new Error("slotDurationMs must be positive");
    }
    if (!input.recurrenceRule || input.recurrenceRule.trim().length === 0) {
      throw new Error("recurrenceRule is required");
    }
    if (input.priceCents !== undefined && input.priceCents < 0) {
      throw new Error("priceCents must be non-negative");
    }

    return this.productRepo.create({
      name: input.name.trim(),
      description: input.description ?? null,
      professional: input.professional.trim(),
      slotDurationMs: input.slotDurationMs,
      recurrenceRule: input.recurrenceRule.trim(),
      timezone: input.timezone ?? "UTC",
      priceCents: input.priceCents ?? 0,
      currency: input.currency ?? "USD",
      maxSubscribers: input.maxSubscribers ?? null,
      active: true,
    });
  }

  getProduct(productId: string): SubscriptionProductRecord {
    const product = this.productRepo.findById(productId);
    if (!product) throw new SubscriptionProductNotFoundError(productId);
    return product;
  }

  listProducts(professional?: string): SubscriptionProductRecord[] {
    if (professional) {
      return this.productRepo.listByProfessional(professional);
    }
    return this.productRepo.listActive();
  }

  deactivateProduct(productId: string): SubscriptionProductRecord {
    const product = this.getProduct(productId);
    return this.productRepo.update(productId, { active: false });
  }

  // ── Subscription Management ──────────────────────────────────────────────

  subscribe(input: SubscribeInput): SubscriptionRecord {
    const product = this.getProduct(input.productId);
    if (!product.active) {
      throw new Error(`Product ${input.productId} is not active`);
    }

    // Check capacity
    if (product.maxSubscribers !== null) {
      const activeCount = this.subscriptionRepo.listActiveByProduct(input.productId).length;
      if (activeCount >= product.maxSubscribers) {
        throw new SubscriptionCapacityExceededError(input.productId);
      }
    }

    // Check for duplicate
    const existing = this.subscriptionRepo.findByProductAndSubscriber(
      input.productId,
      input.subscriberId,
    );
    if (existing) {
      throw new DuplicateSubscriptionError(input.productId, input.subscriberId);
    }

    // Calculate initial next_slot_start_ms based on recurrence
    const nowMs = Date.now();
    const offsetMs = input.slotOffsetMs ?? 0;
    const slots = expandRecurrence(
      product.recurrenceRule,
      nowMs + offsetMs,
      product.slotDurationMs,
      product.slotDurationMs * 365, // 1 year horizon for initial calc
    );

    const nextSlotStartMs = slots.length > 0 ? slots[0].startMs : nowMs;

    return this.subscriptionRepo.create({
      productId: input.productId,
      subscriberId: input.subscriberId,
      status: "active",
      nextSlotStartMs,
      slotOffsetMs: offsetMs,
      slotsMinted: 0,
      pausedAt: null,
      cancelledAt: null,
    });
  }

  pauseSubscription(subscriptionId: string): SubscriptionRecord {
    const sub = this.subscriptionRepo.findById(subscriptionId);
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    if (sub.status !== "active") {
      throw new InvalidSubscriptionStateError(subscriptionId, sub.status, "paused");
    }

    return this.subscriptionRepo.update(subscriptionId, {
      status: "paused",
      pausedAt: new Date().toISOString(),
    });
  }

  resumeSubscription(subscriptionId: string): SubscriptionRecord {
    const sub = this.subscriptionRepo.findById(subscriptionId);
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    if (sub.status !== "paused") {
      throw new InvalidSubscriptionStateError(subscriptionId, sub.status, "active");
    }

    return this.subscriptionRepo.update(subscriptionId, {
      status: "active",
      pausedAt: null,
    });
  }

  cancelSubscription(subscriptionId: string): SubscriptionRecord {
    const sub = this.subscriptionRepo.findById(subscriptionId);
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);

    if (sub.status === "cancelled") {
      throw new InvalidSubscriptionStateError(subscriptionId, sub.status, "cancelled");
    }

    return this.subscriptionRepo.update(subscriptionId, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    });
  }

  getSubscription(subscriptionId: string): SubscriptionRecord {
    const sub = this.subscriptionRepo.findById(subscriptionId);
    if (!sub) throw new SubscriptionNotFoundError(subscriptionId);
    return sub;
  }

  listSubscriptions(productId?: string): SubscriptionRecord[] {
    if (productId) {
      return this.subscriptionRepo.listActiveByProduct(productId);
    }
    return [];
  }

  // ── Slot Generation (called by worker) ───────────────────────────────────

  /**
   * Attempt to mint a single slot for a subscription. Returns the minted slot
   * metadata or throws on conflict/validation error.
   *
   * Idempotency: the caller (worker) is responsible for advancing
   * next_slot_start_ms only after a successful mint.
   */
  mintSlot(subscription: SubscriptionRecord): MintResult {
    const product = this.productRepo.findById(subscription.productId);
    if (!product) {
      throw new SubscriptionProductNotFoundError(subscription.productId);
    }

    const startTime = subscription.nextSlotStartMs;
    const endTime = startTime + product.slotDurationMs;

    // Conflict detection using existing slot repository
    if (this.slotRepo.hasConflict(product.professional, startTime, endTime)) {
      throw new SchedulingConflictError(
        subscription.id,
        product.professional,
        startTime,
        endTime,
      );
    }

    // Create the slot (in a real DB this would be transactional)
    const slotId = `slot-sub-${subscription.id}-${subscription.slotsMinted + 1}`;

    // Calculate the next slot start based on recurrence
    const nextSlots = expandRecurrence(
      product.recurrenceRule,
      startTime + product.slotDurationMs,
      product.slotDurationMs,
      product.slotDurationMs * 2,
    );

    const nextSlotStartMs = nextSlots.length > 0
      ? nextSlots[0].startMs
      : startTime + product.slotDurationMs;

    return {
      subscriptionId: subscription.id,
      slotId,
      professional: product.professional,
      startTime,
      endTime,
      nextSlotStartMs,
    };
  }

  /**
   * Process a batch of due subscriptions, minting slots for each.
   * Used by the generator worker.
   */
  generateSlotsForDueSubscriptions(nowMs: number, batchSize: number = 50): GenerateSlotsResult {
    const dueSubs = this.subscriptionRepo.listActiveDueBefore(nowMs, batchSize);
    const minted: MintResult[] = [];
    const conflicts: string[] = [];
    let skipped = 0;

    for (const sub of dueSubs) {
      try {
        const result = this.mintSlot(sub);

        // Advance the cursor
        this.subscriptionRepo.update(sub.id, {
          nextSlotStartMs: result.nextSlotStartMs,
          slotsMinted: sub.slotsMinted + 1,
        });

        minted.push(result);
      } catch (err) {
        if (err instanceof SchedulingConflictError) {
          conflicts.push(sub.id);
          // Advance cursor to avoid getting stuck on this slot
          const product = this.productRepo.findById(sub.productId);
          if (product) {
            this.subscriptionRepo.update(sub.id, {
              nextSlotStartMs: sub.nextSlotStartMs + product.slotDurationMs,
            });
          }
        } else {
          skipped++;
        }
      }
    }

    return {
      processed: dueSubs.length,
      minted,
      skipped,
      conflicts,
    };
  }
}

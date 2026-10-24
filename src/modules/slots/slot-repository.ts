import type { StrategyId, StrategyConfig } from "../../services/pricingStrategy.js";

/** Optional pricing strategy attached to a slot by the supplier. */
export interface SlotPricingStrategy {
  strategyId: StrategyId;
  /** Base price in the smallest currency unit (e.g. stroops). Must be ≥ 0. */
  basePrice: number;
  /** Maximum concurrent bookings this slot supports (default: 1). */
  capacity?: number;
  /** Strategy-specific configuration. */
  config: StrategyConfig;
}

export interface TimezoneOverride {
  /** IANA timezone identifier (e.g. "America/New_York", "Europe/London") */
  timezone: string;
  /** When this override was set (ISO string) */
  setAt: string;
  /** Who set this override (actor ID) */
  setBy: string;
  /** Optional reason/note for the override */
  reason?: string;
}

export interface StoreTimezoneConfig {
  /** Store identifier */
  storeId: string;
  /** Store-level timezone override */
  timezoneOverride?: TimezoneOverride;
  /** Regions this store operates in (for holiday observance scoping) */
  regionCodes?: string[];
}

export interface SupplierTimezoneContext {
  /** Supplier identifier */
  supplierId: string;
  /** Supplier-level default timezone */
  supplierDefaultTimezone?: TimezoneOverride;
  /** Per-store timezone configurations */
  stores: Record<string, StoreTimezoneConfig>;
}

export interface TenantTimezoneContext {
  /** Tenant identifier */
  tenantId: string;
  /** Tenant-level default timezone (lowest priority fallback) */
  tenantDefaultTimezone: string;
}

export interface TimezoneResolutionResult {
  /** Resolved IANA timezone */
  timezone: string;
  /** Which level the timezone came from: store > supplier > tenant */
  source: "store" | "supplier" | "tenant";
  /** Store ID if resolved from store level */
  storeId?: string;
  /** Audit fields from the override */
  setAt?: string;
  setBy?: string;
  reason?: string;
}

export interface TimezoneResolutionAuditEvent {
  supplierId: string;
  tenantId: string;
  storeId?: string;
  resolvedTimezone: string;
  source: "store" | "supplier" | "tenant";
  candidates: {
    storeTimezone?: string;
    supplierTimezone?: string;
    tenantTimezone: string;
  };
  resolvedAt: string;
  actorId?: string;
}

export interface SlotRecord {
  id: string;
  professional: string;
  startTime: number;
  endTime: number;
  bookable: boolean;
  /** Optional dynamic pricing configuration set by the supplier. */
  pricingStrategy?: SlotPricingStrategy;
  /**
   * Optional bundle expiry timestamp (ms). When set, individual slot redemptions
   * must occur before this deadline; attempts after it fail with SlotExpiredError.
   */
  validUntil?: number;
  /** Supplier who owns this slot (needed for timezone resolution) */
  supplierId?: string;
  /** Store this slot belongs to (needed for timezone resolution) */
  storeId?: string;
  /** Tenant context */
  tenantId?: string;
  /**
   * Slot category (e.g. "medical", "fitness", "beauty").  Used to resolve
   * the per-category no-show grace window.  When absent the system-wide
   * default grace window applies.
   */
  category?: string;
  /** Whether bundle is transferable */
  transferable?: boolean;
  currency?: import("../../utils/amount.js").SupportedCurrencies;
  amount_minor?: number;
}

export interface SlotRepository {
  list(): SlotRecord[];
  findById(slotId: string): SlotRecord | undefined;
  /**
   * Returns true if any existing slot for the same professional overlaps
   * [startTime, endTime). Adjacency (end == start) is NOT a conflict.
   * Optionally excludes a slot by id (used during updates).
   */
  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: string,
  ): boolean;
  /** Atomically update the bookable flag on a slot. */
  updateBookable(slotId: string, bookable: boolean): void;
}

const DEFAULT_SLOTS: SlotRecord[] = [
  {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: true,
  },
  {
    id: "slot-22222222-2222-4222-8222-222222222222",
    professional: "bob",
    startTime: 1_900_000_720_000,
    endTime: 1_900_001_080_000,
    bookable: true,
  },
  {
    id: "slot-33333333-3333-4333-8333-333333333333",
    professional: "charlie",
    startTime: 1_900_001_440_000,
    endTime: 1_900_001_800_000,
    bookable: false,
  },
];

export class InMemorySlotRepository implements SlotRepository {
  private readonly slots: SlotRecord[];

  constructor(seedSlots: SlotRecord[] = DEFAULT_SLOTS) {
    this.slots = seedSlots.map((slot) => ({ ...slot }));
  }

  list(): SlotRecord[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  findById(slotId: string): SlotRecord | undefined {
    const slot = this.slots.find((entry) => entry.id === slotId);
    return slot ? { ...slot } : undefined;
  }

  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: string,
  ): boolean {
    return this.slots.some(
      (s) =>
        s.professional === professional &&
        s.id !== excludeId &&
        s.startTime < endTime &&
        s.endTime > startTime,
    );
  }

  updateBookable(slotId: string, bookable: boolean): void {
    const slot = this.slots.find((s) => s.id === slotId);
    if (!slot) {
      throw new Error(`Slot ${slotId} not found`);
    }
    slot.bookable = bookable;
  }
}

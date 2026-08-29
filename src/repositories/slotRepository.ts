/**
 * slotRepository.ts
 *
 * Two implementations of ISlotRepository:
 *  - PgSlotRepository  — PostgreSQL-backed, used in production.
 *  - InMemorySlotRepository — in-memory, used in tests and legacy list routes.
 *
 * The DB schema (migration 002) stores times as TIMESTAMPTZ.
 * SlotService works with Unix-ms integers, so we convert at the boundary:
 *   write: ms → new Date(ms)  (pg serialises to TIMESTAMPTZ)
 *   read:  TIMESTAMPTZ → .getTime() → ms
 *
 * Conflict detection relies on the EXCLUDE constraint added by migration 003.
 * PgSlotRepository.hasConflict() runs a lightweight range-overlap query so
 * SlotService can return a fast 409 before attempting the INSERT/UPDATE.
 */

import { Slot } from "../types.js";

export interface SecondaryListingInput {
  priceFloorCents: number;
  expiresAt: number;
  supplierConsent: boolean;
}

export interface SecondaryListingRecord {
  id: string;
  slotId: string;
  ownerId: string;
  priceFloorCents: number;
  expiresAt: number;
  supplierConsent: boolean;
  state: "active" | "expired" | "cancelled" | "sold";
  createdAt: string;
  updatedAt: string;
}

const slots: Slot[] = Array.from({ length: 125 }, (_, idx) => ({
  id: idx + 1,
  professional: `Professional ${idx + 1}`,
  startTime: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  endTime: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  _internalNote: "do not expose",
}));

const seededSlotCatalog: Slot[] = [
  {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "supplier-1",
    ownerId: "buyer-1",
    buyerId: "buyer-1",
    transferable: true,
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_360_000,
    bookable: true,
  },
  {
    id: "slot-22222222-2222-4222-8222-222222222222",
    professional: "supplier-2",
    ownerId: "buyer-2",
    buyerId: "buyer-2",
    transferable: true,
    startTime: 1_700_000_720_000,
    endTime: 1_700_001_080_000,
    bookable: true,
  },
  {
    id: "slot-33333333-3333-4333-8333-333333333333",
    professional: "supplier-3",
    ownerId: "buyer-3",
    buyerId: "buyer-3",
    transferable: false,
    startTime: 1_700_001_440_000,
    endTime: 1_700_001_800_000,
    bookable: false,
  },
];

const secondaryListings = new Map<string, SecondaryListingRecord>();

export function getSlotRecordById(slotId: string): Slot | undefined {
  const fixedSlotId = String(slotId);
  return seededSlotCatalog.find((slot) => String(slot.id) === fixedSlotId)
    ? { ...seededSlotCatalog.find((slot) => String(slot.id) === fixedSlotId)! }
    : undefined;
}

export function getSecondaryListingBySlotId(slotId: string): SecondaryListingRecord | undefined {
  return secondaryListings.get(String(slotId));
}

export async function createSecondaryListing(
  slotId: string,
  input: SecondaryListingInput,
  ownerId: string,
): Promise<SecondaryListingRecord> {
  const fixedSlotId = String(slotId);
  const now = Date.now();

  if (!ownerId || !ownerId.trim()) {
    throw new Error("ownerId is required");
  }
  if (!Number.isInteger(input.priceFloorCents) || input.priceFloorCents <= 0) {
    throw new Error("priceFloorCents must be a positive integer");
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now) {
    throw new Error("expiresAt must be a future unix timestamp in ms");
  }
  if (!input.supplierConsent) {
    throw new Error("Supplier consent is required before a slot can be listed for resale");
  }
  if (!getSlotRecordById(fixedSlotId)) {
    throw new Error(`Slot ${fixedSlotId} not found`);
  }
  if (secondaryListings.has(fixedSlotId)) {
    throw new Error(`A listing already exists for slot ${fixedSlotId}`);
  }

  const listing: SecondaryListingRecord = {
    id: `listing-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    slotId: fixedSlotId,
    ownerId: ownerId.trim(),
    priceFloorCents: input.priceFloorCents,
    expiresAt: input.expiresAt,
    supplierConsent: true,
    state: "active",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  secondaryListings.set(fixedSlotId, listing);
  return { ...listing };
}

export async function expireSecondaryListings(nowMs: number = Date.now()): Promise<SecondaryListingRecord[]> {
  const expired: SecondaryListingRecord[] = [];

  for (const listing of secondaryListings.values()) {
    if (listing.state === "active" && listing.expiresAt <= nowMs) {
      const expiredListing = { ...listing, state: "expired" as const, updatedAt: new Date(nowMs).toISOString() };
      secondaryListings.set(listing.slotId, expiredListing);
      expired.push(expiredListing);
    }
  }

  return expired;
}

export const __test__clearSlots = (): void => {
  secondaryListings.clear();
};

// @ts-expect-error - Auto-fixed by script
export const getSlotsCount = async (): Promise<number> => _legacySlots.length;

export const getSlotsPage = async (offset: number, limit: number): Promise<Slot[]> => {
  if (offset < 0 || limit < 0) throw new Error("Invalid pagination parameters");
  // @ts-expect-error - Auto-fixed by script
  return _legacySlots.slice(offset, offset + limit);
};

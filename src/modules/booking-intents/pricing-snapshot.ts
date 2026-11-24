import type { SlotRecord } from "../slots/slot-repository.js";
import type { BookingIntentRecord, PricingSnapshot } from "./booking-intent-repository.js";
import { resolvePrice } from "../../services/pricingStrategy.js";

/**
 * Resolve the pricing snapshot for a slot given the current set of booking
 * intents and a fixed "now" timestamp (epoch ms).
 *
 * Only intents whose `slotId` matches the slot **and** whose status is
 * `"pending"` or `"confirmed"` are counted toward `activeBookings`.
 * Capacity defaults to `1` when the slot's pricing strategy omits it.
 *
 * Returns `undefined` when the slot has no pricing strategy attached, so
 * callers can treat the absence of dynamic pricing as "no snapshot".
 *
 * The function is a pure function of its inputs — given the same slot,
 * intents and `nowMs` it always returns the same snapshot (deterministic /
 * snapshot-safe).
 */
export function resolvePricingSnapshot(
  slot: SlotRecord,
  intents: BookingIntentRecord[],
  nowMs: number,
): PricingSnapshot | undefined {
  const ps = slot.pricingStrategy;
  if (!ps) {
    return undefined;
  }

  const activeBookings = intents.filter(
    (intent) =>
      intent.slotId === slot.id &&
      (intent.status === "pending" || intent.status === "confirmed"),
  ).length;

  const capacity = ps.capacity ?? 1;

  const result = resolvePrice(ps.strategyId, {
    basePrice: ps.basePrice,
    slotStartMs: slot.startTime,
    nowMs,
    activeBookings,
    capacity,
    config: ps.config,
  });

  return {
    strategyId: result.strategyId,
    resolvedPrice: result.price,
    basePrice: ps.basePrice,
    slotStartMs: slot.startTime,
    nowMs,
    activeBookings,
    capacity,
    config: ps.config,
  };
}

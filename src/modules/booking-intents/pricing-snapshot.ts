import type { BookingIntentRecord, PricingSnapshot } from "./booking-intent-repository.js";
import type { SlotRecord } from "../slots/slot-repository.js";
import { resolvePrice } from "../../services/pricingStrategy.js";

export function resolvePricingSnapshot(
  slot: SlotRecord,
  intents: readonly BookingIntentRecord[],
  nowMs: number,
): PricingSnapshot | undefined {
  const strategy = slot.pricingStrategy;
  if (!strategy) {
    return undefined;
  }

  const activeBookings = intents.filter(
    (intent) =>
      intent.slotId === slot.id && (intent.status === "pending" || intent.status === "confirmed"),
  ).length;
  const capacity = strategy.capacity ?? 1;
  const result = resolvePrice(strategy.strategyId, {
    basePrice: strategy.basePrice,
    slotStartMs: slot.startTime,
    nowMs,
    activeBookings,
    capacity,
    config: strategy.config,
  });

  return {
    strategyId: result.strategyId,
    resolvedPrice: result.price,
    basePrice: strategy.basePrice,
    slotStartMs: slot.startTime,
    nowMs,
    activeBookings,
    capacity,
    config: strategy.config,
  };
}

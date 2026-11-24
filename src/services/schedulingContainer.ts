/**
 * schedulingContainer.ts
 *
 * Provides the shared SchedulingService instance and its underlying
 * repositories.  Both the booking-intent route and the refundable-hold
 * sweeper import from here so that slot-bookable state mutations made via
 * reserveSlot / releaseSlot are always visible to both sides.
 */

import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { SchedulingService } from "./schedulingService.js";

export const sharedSlotRepository = new InMemorySlotRepository();
export const sharedBookingIntentRepository = new InMemoryBookingIntentRepository();

export const sharedSchedulingService = new SchedulingService(
  sharedSlotRepository,
  sharedBookingIntentRepository,
);

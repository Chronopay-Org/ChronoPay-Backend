/**
 * Process-wide singleton composition for booking intents.
 *
 * The HTTP router (src/routes/booking-intents.ts) and the hold auto-refund
 * worker (src/scheduler/holdAutoRefundWorker.ts) must share the same
 * InMemoryBookingIntentRepository and InMemorySlotRepository so that holds
 * created through the API are visible to the worker, and worker-issued refunds
 * are visible through the GET endpoints.
 *
 * Tests that need isolated state should call createBookingIntentContainer()
 * with fresh repository instances rather than importing the default singleton.
 */

import { InMemoryBookingIntentRepository } from "./booking-intent-repository.js";
import { InMemorySlotRepository } from "../slots/slot-repository.js";
import { BookingIntentService } from "./booking-intent-service.js";

export interface BookingIntentRepositories {
  bookingIntentRepository: InMemoryBookingIntentRepository;
  slotRepository: InMemorySlotRepository;
}

/** Factory — use this in tests to get independent, isolated state. */
export function createBookingIntentContainer(
  repositories: Partial<BookingIntentRepositories> = {},
) {
  const bookingIntentRepository =
    repositories.bookingIntentRepository ?? new InMemoryBookingIntentRepository();
  const slotRepository = repositories.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(bookingIntentRepository, slotRepository);
  return { bookingIntentRepository, slotRepository, bookingIntentService };
}

/** Default process-wide singleton. Import from here — never construct a second set. */
export const bookingIntentContainer = createBookingIntentContainer();
export const { bookingIntentRepository, slotRepository, bookingIntentService } =
  bookingIntentContainer;

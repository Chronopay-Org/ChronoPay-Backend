/**
 * refundableHoldContainer.ts
 *
 * Exports a single shared InMemoryRefundableHoldRepository instance that is
 * used by both SchedulingService (via BookingIntentService) when a
 * refundable_hold intent is created, and by the refundable-hold sweeper loop
 * started in src/index.ts.
 *
 * Both consumers import `sharedHoldRepository` from this module, ensuring
 * the sweeper sees every hold that the booking path creates.
 */

import { InMemoryRefundableHoldRepository } from "./refundableHoldSweeper.js";

export const sharedHoldRepository = new InMemoryRefundableHoldRepository();

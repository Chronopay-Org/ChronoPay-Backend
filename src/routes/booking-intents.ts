/**
 * @file src/routes/booking-intents.ts
 *
 * Express router for the /api/v1/booking-intents resource.
 *
 * POST /api/v1/booking-intents
 *   Creates a new booking intent with strict validation.
 *   Protected by feature flag FF_CREATE_BOOKING_INTENT.
 *   Requires JWT authentication via the Authorization Bearer token.
 */

import { Router, Request, Response, NextFunction } from "express";
import { requireAuthenticatedActor, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { auditMiddleware } from "../middleware/audit.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import {
    BookingIntentService,
    parseCreateBookingIntentBody,
} from "../modules/booking-intents/booking-intent-service.js";
import { BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { PgBookingIntentRepository } from "../modules/booking-intents/pg-booking-intent-repository.js";
import { SlotRepository, InMemorySlotRepository } from "../modules/slots/slot-repository.js";

export function createBookingIntentsRouter(
    bookingIntentRepository: BookingIntentRepository = new PgBookingIntentRepository(),
    slotRepository: SlotRepository = new InMemorySlotRepository(),
) {
    const router = Router();

    const bookingIntentService = new BookingIntentService(
        bookingIntentRepository,
        slotRepository,
    );

    router.post(
        "/",
        requireFeatureFlag("CREATE_BOOKING_INTENT"),
        requireAuthenticatedActor(["customer", "admin"]),
        createAuthAwareRateLimiter(),
        auditMiddleware("CREATE_BOOKING_INTENT"),
        async (req: AuthenticatedRequest, res: Response): Promise<void> => {
            try {
                const input = parseCreateBookingIntentBody(req.body);
                const intent = await bookingIntentService.createIntent(input, req.auth!);

                res.status(201).json({
                    success: true,
                    intent,
                });
            } catch (error) {
                next(error);
            }
        },
    );

    return router;
}

export default createBookingIntentsRouter();

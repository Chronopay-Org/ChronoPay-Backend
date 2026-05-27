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
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { logger } from "../utils/logger.js";

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
        (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
            try {
                const input = parseCreateBookingIntentBody(req.body);
                const intent = await bookingIntentService.createIntent(input, req.auth!);

                res.status(201).json({
                    success: true,
                    intent,
                });
            } catch (error) {
                if (error instanceof BookingIntentError) {
                    res.status(error.status).json({
                        success: false,
                        error: error.message,
                        requestId: req.requestId ?? req.id,
                    });
                    return;
                }

                logger.error({ err: error, requestId: req.requestId ?? req.id }, "Unexpected error in booking intent creation");
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    requestId: req.requestId ?? req.id,
                });
            }
        },
    );

    return router;
}

export default createBookingIntentsRouter();

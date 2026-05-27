/**
 * @file src/routes/booking-intents.ts
 *
 * Express router for the /api/v1/booking-intents resource.
 *
 * POST /api/v1/booking-intents
 *   Creates a new booking intent with strict validation.
 *   Protected by feature flag FF_CREATE_BOOKING_INTENT.
 *   Requires authentication via x-chronopay-user-id and x-chronopay-role headers.
 */

import { Router, Request, Response, NextFunction } from "express";
import { requireAuthenticatedActor, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { auditMiddleware } from "../middleware/audit.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";
import {
    BookingIntentService,
    parseCreateBookingIntentBody,
} from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

export function createBookingIntentsRouter() {
    const router = Router();

    // ─── Repositories (replace with DB layer in production) ────────────────────
    const bookingIntentRepository = new InMemoryBookingIntentRepository();
    const slotRepository = new InMemorySlotRepository();
    const bookingIntentService = new BookingIntentService(
        bookingIntentRepository,
        slotRepository,
    );

    router.post(
        "/",
        ...payloadLimit(ROUTE_PAYLOAD_LIMITS.bookingIntent),
        requireFeatureFlag("CREATE_BOOKING_INTENT"),
        requireAuthenticatedActor(["customer", "admin"]),
        createAuthAwareRateLimiter(),
        auditMiddleware("CREATE_BOOKING_INTENT"),
        (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
            try {
                const input = parseCreateBookingIntentBody(req.body);
                const intent = bookingIntentService.createIntent(input, req.auth!);

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

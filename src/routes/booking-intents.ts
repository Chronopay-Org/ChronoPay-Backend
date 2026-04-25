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

import { Router, Request, Response } from "express";
import { requireAuthenticatedActor, type AuthenticatedRequest } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { auditMiddleware } from "../middleware/audit.js";
import {
    BookingIntentService,
    BookingIntentError,
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
        requireFeatureFlag("CREATE_BOOKING_INTENT"),
        requireAuthenticatedActor(["customer", "admin"]),
        auditMiddleware("CREATE_BOOKING_INTENT"),
        (req: AuthenticatedRequest, res: Response): void => {
            try {
                const input = parseCreateBookingIntentBody(req.body);
                const intent = bookingIntentService.createIntent(input, req.auth!);

                res.status(201).json({
                    success: true,
                    intent,
                });
            } catch (error) {
                if (error instanceof BookingIntentError) {
                    res.status(error.status).json({
                        success: false,
                        error: error.message,
                    });
                    return;
                }

                console.error("Unexpected error in booking intent creation:", error);
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                });
            }
        },
    );

    return router;
}

export default createBookingIntentsRouter();

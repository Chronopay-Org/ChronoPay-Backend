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
    bookingIntentRepository?: InMemoryBookingIntentRepository,
    slotRepository?: InMemorySlotRepository
) {
    const router = Router();
    // Allow injection for testing; default to in-memory if not provided
    const _bookingIntentRepository = bookingIntentRepository || new InMemoryBookingIntentRepository();
    const _slotRepository = slotRepository || new InMemorySlotRepository();
    const bookingIntentService = new BookingIntentService(
        _bookingIntentRepository,
        _slotRepository,
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
                        requestId: req.requestId ?? req.id,
                    });
                    return;
                }
                console.error("Unexpected error in booking intent creation:", error);
                res.status(500).json({
                    success: false,
                    error: "Internal server error",
                    requestId: req.requestId ?? req.id,
                });
            }
        },
    );

    // GET /:id - Retrieve a booking intent by ID (owner or admin only)
    router.get(
        "/:id",
        requireAuthenticatedActor(["customer", "admin"]),
        async (req: AuthenticatedRequest, res: Response) => {
            const { id } = req.params;
            const auth = req.auth!;
            const intent = _bookingIntentRepository.findById(id);
            if (!intent) {
                return res.status(404).json({ success: false, error: "Not found" });
            }
            // Only owner or admin can access
            if (auth.role === "admin" || intent.customerId === auth.userId) {
                return res.json({ success: true, intent });
            }
            // Do not leak existence
            return res.status(404).json({ success: false, error: "Not found" });
        }
    );

    // GET / - List booking intents for authenticated user (admin gets all)
    router.get(
        "/",
        requireAuthenticatedActor(["customer", "admin"]),
        async (req: AuthenticatedRequest, res: Response) => {
            const auth = req.auth!;
            let intents;
            if (auth.role === "admin") {
                intents = _bookingIntentRepository.listAll();
            } else {
                intents = _bookingIntentRepository.listByCustomer(auth.userId);
            }
            return res.json({ success: true, intents });
        }
    );

    return router;
}

export default createBookingIntentsRouter();

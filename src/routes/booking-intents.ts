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

import { Router, type Request, Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { auditMiddleware } from "../middleware/audit.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  BookingIntentService,
  BookingIntentError,
  parseCreateBookingIntentBody,
} from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { logger } from "../utils/logger.js";

export function createBookingIntentsRouter() {
  const router = Router();

  // ─── Repositories (replace with DB layer in production) ────────────────────
  const bookingIntentRepository = new InMemoryBookingIntentRepository();
  const slotRepository = new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(bookingIntentRepository, slotRepository);

  function handleServiceError(error: unknown, res: Response): void {
    if (error instanceof BookingIntentError) {
      res.status(error.status).json({
        success: false,
        error: error.message,
        code: error.code,
      });
      return;
    }

    logger.error({ err: error }, "Unexpected error in booking intent operation");
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }

  router.post(
    "/",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    idempotencyMiddleware,
    createAuthAwareRateLimiter(),
    auditMiddleware("CREATE_BOOKING_INTENT"),
    (req: Request, res: Response): void => {
      try {
        const input = parseCreateBookingIntentBody(req.body);
        // Evaluate fraud risk
        const { FraudScorer } = require('../services/fraudScorer.js');
        const fraudScorer = new FraudScorer();
        const fraudResult = fraudScorer.evaluate(input.id ?? 'temp-intent-id', req);
        const threshold = fraudScorer.getThreshold();
        if (fraudResult.score >= threshold) {
          if (fraudScorer.getStepUpMode() === 'challenge') {
            // Return challenge token response
            const challengeToken = require('crypto').randomUUID();
            return res.status(202).json({
              success: false,
              challengeRequired: true,
              challengeToken,
            });
          } else {
            // Quarantine path
            const { QuarantineStore } = require('../services/quarantineStore.js');
            const store = new QuarantineStore();
            const quarantineId = store.add({ input, actorId: (req as any).auth?.userId, fraudResult });
            return res.status(202).json({
              success: true,
              quarantineId,
            });
          }
        }
        const intent = bookingIntentService.createIntent(input, req.auth!);
        res.status(201).json({
          success: true,
          intent,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/confirm",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("CONFIRM_BOOKING_INTENT"),
    (req: Request, res: Response): void => {
      try {
        const intent = bookingIntentService.confirmIntent(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          intent,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/cancel",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("CANCEL_BOOKING_INTENT"),
    (req: Request, res: Response): void => {
      try {
        const intent = bookingIntentService.cancelIntent(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          intent,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  return router;
}

export default createBookingIntentsRouter();

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

import { Router, type Request, Response, type NextFunction } from "express";
import { configService } from "../config/config.service.js";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { requireFreshMfa } from "../middleware/requireFreshMfa.js";
import { auditMiddleware } from "../middleware/audit.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { validateBody } from "../middleware/validation.js";
import {
  antiFraudScoring,
  captureRequestBody,
  enqueueHitlReviewForIntent,
} from "../middleware/fraudScoring.js";
import {
  CreateBookingIntentBodySchema,
  type CreateBookingIntentBody,
} from "../middleware/schemas.js";
import {
  BookingIntentService,
  BookingIntentError,
} from "../modules/booking-intents/booking-intent-service.js";
import { isAppError } from "../errors/AppError.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { logger } from "../utils/logger.js";
import { FraudScorer } from "../services/fraudScorer.js";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";

export function createBookingIntentsRouter(
  options: {
    bookingIntentRepository?: InMemoryBookingIntentRepository;
    slotRepository?: InMemorySlotRepository;
  } = {},
) {
  const router = Router();
  // ─── Repositories (replace with DB layer in production) ────────────────────
  const bookingIntentRepository =
    options.bookingIntentRepository ?? new InMemoryBookingIntentRepository();
  const slotRepository = options.slotRepository ?? new InMemorySlotRepository();
  const bookingIntentService = new BookingIntentService(bookingIntentRepository, slotRepository);

  function handleServiceError(error: unknown, res: Response): void {
    if (error instanceof BookingIntentError) {
      // Emit the shared AppError envelope so every route answers with the
      // same shape (success/code/message/error/timestamp).
      res.status(error.status).json(error.toJSON());
      return;
    }

    if (isAppError(error)) {
      res.status(error.statusCode).json(error.toJSON());
      return;
    }

    logger.error({ err: error }, "Unexpected error in booking intent operation");
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }

  const fraudScorer = new FraudScorer();

  // Step-up MFA gate for customer refunds. Active only when
  // MFA_REQUIRED_FOR_REFUNDS is enabled (default: on in production, off in
  // development/test). Mounted directly after authentication so
  // `req.auth.userId` is populated before the challenge subject check.
  const freshMfaForRefund = requireFreshMfa();
  const requireMfaForRefund = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    if (!configService.mfaRequiredForRefunds) {
      return next();
    }
    return freshMfaForRefund(req, res, next);
  };

  router.post(
    "/",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    ...payloadLimit(ROUTE_PAYLOAD_LIMITS.bookingIntent),
    requireAuthenticatedActor(["customer", "admin"]),
    // Preserve the pre-validation body so the fraud wall (below) can still see
    // client-supplied fields the body schema strips (e.g. email) without
    // expanding the public request contract.
    captureRequestBody,
    validateBody(CreateBookingIntentBodySchema),
    // Ordering requirement: must run after requireAuthenticatedActor so
    // idempotencyMiddleware can namespace Idempotency-Key entries by the
    // verified caller (req.auth.userId) instead of a global key.
    idempotencyMiddleware,
    createAuthAwareRateLimiter(),
    auditMiddleware("CREATE_BOOKING_INTENT"),
    // Screens every new intent (idempotent replays short-circuit before this).
    // Runs after the audit middleware so blocked requests are still audited;
    // blocks or steps up via challenge/quarantine on high scores.
    antiFraudScoring({ scorer: fraudScorer }),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const input = req.body as CreateBookingIntentBody;
        if (input.rrule !== undefined) {
          const report = await bookingIntentService.createRecurringIntents(
            {
              rrule: input.rrule,
              note: input.note,
              bookingType: input.bookingType,
              holdDeadlineMs: input.holdDeadlineMs,
            },
            req.auth!,
          );
          // Borderline fraud scores are queued for HITL here — the middleware
          // cannot know the ids before creation (issue #1345). One review item
          // per created intent so reviewers can open the real intent.
          for (const created of report.successes) {
            enqueueHitlReviewForIntent(req, created.id);
          }
          res.status(201).json({
            success: true,
            report,
          });
        } else if (input.slotId !== undefined) {
          const intent = await bookingIntentService.createIntent(
            {
              slotId: input.slotId,
              note: input.note,
              bookingType: input.bookingType,
              holdDeadlineMs: input.holdDeadlineMs,
            },
            req.auth!,
          );
          enqueueHitlReviewForIntent(req, intent.id);
          res.status(201).json({
            success: true,
            intent,
          });
        } else {
          // The schema requires one of slotId/rrule; keep the contract explicit
          // for callers that bypass body validation.
          throw new BookingIntentError(400, "slotId is required when rrule is not provided.");
        }
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.get(
    "/",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const intents = await bookingIntentService.listIntents(req.auth!);
        res.status(200).json({
          success: true,
          intents,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.get(
    "/:id",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const intent = await bookingIntentService.getIntent(req.params.id, req.auth!);
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
    "/:id/confirm",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("CONFIRM_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const intent = await bookingIntentService.confirmIntent(req.params.id, req.auth!);
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
    async (req: Request, res: Response): Promise<void> => {
      try {
        const intent = await bookingIntentService.cancelIntent(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          intent,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  /**
   * @route POST /api/v1/booking-intents/:id/refund
   * @desc Refund a booking intent, prorated by consumption.
   * @header x-chronopay-mfa — fresh MFA challenge token (from POST /api/v1/auth/mfa/verify).
   *       Enforced when MFA_REQUIRED_FOR_REFUNDS is enabled (default in
   *       production): 401 when missing/expired, 403 when bound to another subject.
   * @access Private (customer or admin + conditional MFA step-up)
   */
  /**
   * @openapi
   * /api/v1/booking-intents/{id}/refund:
   *   post:
   *     summary: Refund a booking intent
   *     description: >
   *       Refunds a booking intent, prorated by consumption. When
   *       MFA_REQUIRED_FOR_REFUNDS is enabled (default in production) the
   *       caller must present a fresh MFA step-up challenge bound to the
   *       authenticated subject.
   *     tags: [BookingIntents]
   *     security:
   *       - chronoPayAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *       - in: header
   *         name: x-chronopay-mfa
   *         required: false
   *         schema:
   *           type: string
   *         description: >
   *           Fresh MFA challenge token from POST /api/v1/auth/mfa/verify.
   *           Required when MFA_REQUIRED_FOR_REFUNDS is enabled (default in
   *           production): 401 when missing or older than the freshness
   *           window, 403 when issued for a different subject.
   *     responses:
   *       200:
   *         description: Refund calculated and recorded
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                   example: true
   *       401:
   *         description: Missing identity, or missing/expired MFA challenge
   *       403:
   *         description: MFA challenge issued for a different subject
   */
  router.post(
    "/:id/refund",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    requireMfaForRefund,
    createAuthAwareRateLimiter(),
    auditMiddleware("REFUND_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        const cancelledAtMs =
          typeof req.body?.cancelledAtMs === "number" ? req.body.cancelledAtMs : undefined;

        if (
          req.body &&
          Object.prototype.hasOwnProperty.call(req.body, "cancelledAtMs") &&
          cancelledAtMs === undefined
        ) {
          throw new BookingIntentError(400, "cancelledAtMs must be a valid number.");
        }

        const refund = await bookingIntentService.refundIntent(req.params.id, req.auth!, {
          reason,
          cancelledAtMs,
        });

        res.status(200).json({
          success: true,
          refund,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/no-show",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["professional", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("MARK_NO_SHOW"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        const forfeitRatio =
          typeof req.body?.forfeitRatio === "number" ? req.body.forfeitRatio : undefined;

        const result = await bookingIntentService.markNoShow(req.params.id, req.auth!, {
          reason,
          forfeitRatio,
        });

        res.status(200).json({
          success: true,
          result,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.get(
    "/:id/cancel-preview",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const preview = await bookingIntentService.previewCancel(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          preview,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.get(
    "/:id/hold-status",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "professional", "admin"]),
    createAuthAwareRateLimiter(),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const status = await bookingIntentService.getHoldStatus(req.params.id, req.auth!);
        res.status(200).json({
          success: true,
          holdStatus: status,
        });
      } catch (error) {
        handleServiceError(error, res);
      }
    },
  );

  router.post(
    "/:id/auto-refund-hold",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("AUTO_REFUND_HOLD"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        // Admin-only endpoint: allow an explicit `force: true` body flag to
        // refund a hold before its holdUntilMs deadline. The worker path never
        // passes force, so it keeps the strict expiry guard.
        const force =
          req.body !== null &&
          typeof req.body === "object" &&
          (req.body as { force?: unknown }).force === true;
        const intent = bookingIntentService.autoRefundHold(req.params.id, { force });
        const intent = await bookingIntentService.autoRefundHold(req.params.id);
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

export default createBookingIntentsRouter;

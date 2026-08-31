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
import { validateBody } from "../middleware/validation.js";
import {
  CreateBookingIntentBodySchema,
} from "../middleware/schemas.js";
import {
  BookingIntentService,
  BookingIntentError,
  parseCreateBookingIntentBody,
} from "../modules/booking-intents/booking-intent-service.js";
import { isAppError } from "../errors/AppError.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { logger } from "../utils/logger.js";
import { recordFraudScore } from "../metrics/fraudDriftMetrics.js";
import { fraudReviewQueue } from "../services/fraudReviewQueue.js";
import { FraudScorer } from "../services/fraudScorer.js";
import {
  FraudReasonCode,
  getFraudReasonCode,
  getFraudMessage,
} from "../services/fraudReasonCodes.js";
import { QuarantineStore } from "../services/quarantineStore.js";
import { InMemoryFxRateProvider } from "../services/fxRateProvider.js";

export function createBookingIntentsRouter(
  options: {
    bookingIntentRepository?: InMemoryBookingIntentRepository;
    slotRepository?: InMemorySlotRepository;
  } = {},
) {
  /**
   * Recurring booking requests are identified by an `rrule` field and are
   * mutually exclusive with a single-`slotId` booking. Rejecting payloads that
   * carry both removes a silently-ambiguous contract (previously `rrule` won
   * and `slotId` was ignored) before any downstream work happens.
   *
   * @throws BookingIntentError(400) when both `slotId` and `rrule` are present.
   */
  function assertNotAmbiguousBookingPayload(body: unknown): void {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const candidate = body as Record<string, unknown>;
      if (candidate.slotId !== undefined && candidate.rrule !== undefined) {
        throw new BookingIntentError(
          400,
          "slotId and rrule are mutually exclusive: provide either a single slotId or a recurring rrule.",
        );
      }
    }
  }

  const router = Router();

  // ─── Repositories (replace with DB layer in production) ────────────────────
  const bookingIntentRepository =
    options.bookingIntentRepository ?? new InMemoryBookingIntentRepository();
  const slotRepository = options.slotRepository ?? new InMemorySlotRepository();
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

    if (isAppError(error)) {
      res.status(error.statusCode).json({
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

  const fraudScorer = new FraudScorer();

  router.post(
    "/",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["customer", "admin"]),
    validateBody(CreateBookingIntentBodySchema),
    idempotencyMiddleware,
    createAuthAwareRateLimiter(),
    auditMiddleware("CREATE_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        assertNotAmbiguousBookingPayload(req.body);
        const input = parseCreateBookingIntentBody(req.body);
        const fraudResult = fraudScorer.evaluate(
          (input as any).slotId ?? (input as any).rrule ?? "temp-intent-id",
          req,
        );
        const threshold = fraudScorer.getThreshold();
        // Feed the live score into the fraud drift detector. The metrics
        // module is import-side-effect-free so a missing baseline is a no-op
        // rather than a request blocker. `FRAUD_MODEL_VERSION` threads the
        // histogram label through the deployment env (e.g. "2025-q1-r3").
        recordFraudScore(`v${process.env.FRAUD_MODEL_VERSION || "default"}`, fraudResult.score);

        // Medium risk -> HITL review queue
        if (fraudResult.score === threshold - 1 && fraudResult.score > 0) {
          fraudReviewQueue.enqueue("temp-intent-id", fraudResult.score, fraudResult.reasons);
        }

        if (fraudResult.score >= threshold) {
          const locale = req.headers["accept-language"]?.split(",")[0].split("-")[0] || "en";

          const publicCodes = Array.from(
            new Set(fraudResult.reasons.map((r: string) => getFraudReasonCode(r))),
          );
          if (publicCodes.length === 0) publicCodes.push(FraudReasonCode.UNKNOWN_RISK);

          const errorPayload = {
            success: false,
            error: "Booking intent blocked due to security policies.",
            reasonCodes: publicCodes,
            messages: publicCodes.map((code) => getFraudMessage(code, locale)),
          };

          if (fraudScorer.getStepUpMode() === "challenge") {
            const challengeToken = crypto.randomUUID();
            return res.status(403).json({
              ...errorPayload,
              challengeRequired: true,
              challengeToken,
            });
          } else {
            const store = new QuarantineStore();
            const quarantineId = store.add({
              input,
              actorId: req.auth?.userId,
              fraudResult,
            });
            return res.status(403).json({
              ...errorPayload,
              quarantineId,
            });
          }
        }
        if ("rrule" in input) {
          const report = await bookingIntentService.createRecurringIntents(input, req.auth!);
          res.status(201).json({
            success: true,
            report,
          });
        } else {
          const intent = await bookingIntentService.createIntent(input, req.auth!);
          res.status(201).json({
            success: true,
            intent,
          });
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
    (req: Request, res: Response): void => {
      try {
        const intents = bookingIntentService.listIntents(req.auth!);
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
    (req: Request, res: Response): void => {
      try {
        const intent = bookingIntentService.getIntent(req.params.id, req.auth!);
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

  router.post(
    "/:id/no-show",
    requireFeatureFlag("CREATE_BOOKING_INTENT"),
    requireAuthenticatedActor(["professional", "admin"]),
    createAuthAwareRateLimiter(),
    auditMiddleware("NO_SHOW_BOOKING_INTENT"),
    async (req: Request, res: Response): Promise<void> => {
      try {
        const forfeitRatio =
          typeof req.body?.forfeitRatio === "number" ? req.body.forfeitRatio : undefined;
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;

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
    (req: Request, res: Response): void => {
      try {
        const preview = bookingIntentService.previewCancel(req.params.id, req.auth!);
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
    (req: Request, res: Response): void => {
      try {
        const status = bookingIntentService.getHoldStatus(req.params.id, req.auth!);
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
    (req: Request, res: Response): void => {
      try {
        const intent = bookingIntentService.autoRefundHold(req.params.id);
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

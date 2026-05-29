/**
 * @file src/routes/notifications.ts
 *
 * Express router for /api/v1/notifications.
 *
 * POST /api/v1/notifications/sms
 *   Sends an SMS notification.
 *   Protected by feature flag FF_SMS_NOTIFICATIONS.
 *   Requires authentication via x-chronopay-user-id and x-chronopay-role headers.
 *   Rate-limited per authenticated principal.
 */

import { Router, type Request, Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import { SmsNotificationService, InMemorySmsProvider, type SmsProvider } from "../services/smsNotification.js";

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export function createNotificationsRouter(
  smsService?: SmsNotificationService,
) {
  const router = Router();
  const service = smsService ?? new SmsNotificationService(new InMemorySmsProvider());

  router.post(
    "/sms",
    requireFeatureFlag("SMS_NOTIFICATIONS"),
    requireAuthenticatedActor(["customer", "admin"]),
    createAuthAwareRateLimiter(),
    (req: Request, res: Response): void => {
      const { to, message } = req.body ?? {};

      if (typeof to !== "string" || !to.trim()) {
        res.status(400).json({ success: false, error: "Recipient number is required" });
        return;
      }

      if (typeof message !== "string" || !message.trim()) {
        res.status(400).json({ success: false, error: "SMS message is required" });
        return;
      }

      const normalizedTo = to.trim();

      if (!E164_PATTERN.test(normalizedTo)) {
        res.status(400).json({
          success: false,
          error: "Recipient number must be in E.164 format (example: +12025550123)",
        });
        return;
      }

      service.send(normalizedTo, message.trim())
        .then((result) => {
          if (!result.success) {
            res.status(502).json({ success: false, error: result.error });
            return;
          }
          res.status(200).json({
            success: true,
            provider: result.provider,
            providerMessageId: result.providerMessageId,
          });
        })
        .catch(() => {
          res.status(500).json({ success: false, error: "Internal server error" });
        });
    },
  );

  return router;
}

export default createNotificationsRouter;

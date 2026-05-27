import { Express, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";

const allowedEventTypes = new Set([
  "settlement_completed",
  "settlement_initiated",
  "settlement_failed",
]);

const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

export interface WebhookRouteOptions {
  signingSecret?: string;
}

export function registerWebhookRoutes(app: Express, options: WebhookRouteOptions = {}) {
  app.post(
    "/api/v1/webhooks/settlements",
    internalHmacAuth(options.signingSecret),
    validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
    (req: Request, res: Response) => {
      const { eventType, amount, timestamp } = req.body;

      if (!allowedEventTypes.has(eventType)) {
        return res.status(400).json({
          success: false,
          error: "Invalid eventType. Allowed values are settlement_completed, settlement_initiated, settlement_failed.",
        });
      }

      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: "Invalid amount. Amount must be a positive number.",
        });
      }

      if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
        return res.status(400).json({
          success: false,
          error: "Invalid timestamp. Timestamp must be a positive number.",
        });
      }

      const ageMs = Date.now() - timestamp;
      if (ageMs > 5 * 60 * 1000 || ageMs < -CLOCK_SKEW_MS) {
        return res.status(403).json({
          success: false,
          error: "Rejected stale or future webhook payload.",
        });
      }

      return res.status(200).json({
        success: true,
        received: req.body,
      });
    },
  );
}

import { Express, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";

const allowedEventTypes = new Set([
  "settlement_completed",
  "settlement_initiated",
  "settlement_failed",
]);

const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

interface ProcessedEvent {
  eventType: string;
  processedAt: number;
  response: { success: boolean; received: unknown };
}

// In-process dedup store: transactionId → ProcessedEvent.
// Injectable via _setProcessedTransactions() for test isolation.
let _processedTransactions: Map<string, ProcessedEvent> = new Map();

export function _setProcessedTransactions(store: Map<string, ProcessedEvent>): void {
  _processedTransactions = store;
}

export function _resetProcessedTransactions(): void {
  _processedTransactions = new Map();
}

router.post("/settlements", (req: Request, res: Response) => {
  const { eventType, transactionId, amount, timestamp } = req.body ?? {};

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

  // Idempotency check: short-circuit duplicate transactionIds.
  const existing = _processedTransactions.get(String(transactionId));
  if (existing) {
    return res.status(200).json(existing.response);
  }

  const responseBody = { success: true, received: req.body };

  _processedTransactions.set(String(transactionId), {
    eventType: String(eventType),
    processedAt: Date.now(),
    response: responseBody,
  });

  return res.status(200).json(responseBody);
});

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

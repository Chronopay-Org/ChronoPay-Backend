import { Express, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";
import { KycProvider } from "../services/kycProvider.js";
import { MockKycProvider } from "../services/mockKycProvider.js";
import { KycService } from "../services/kycService.js";

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

let _processedTransactions: Map<string, ProcessedEvent> = new Map();

export function _setProcessedTransactions(store: Map<string, ProcessedEvent>): void {
  _processedTransactions = store;
}

export function _resetProcessedTransactions(): void {
  _processedTransactions = new Map();
}

export interface WebhookRouteOptions {
  signingSecret?: string;
  kycSigningSecret?: string;
  kycProvider?: KycProvider;
}

export function registerWebhookRoutes(app: Express, options: WebhookRouteOptions = {}) {
  app.post(
    "/api/v1/webhooks/settlements",
    internalHmacAuth(options.signingSecret),
    validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
    (req: Request, res: Response) => {
      // eslint-disable-next-line unused-imports/no-unused-vars
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

      const existing = _processedTransactions.get(String(req.body.transactionId));
      if (existing) {
        return res.status(200).json(existing.response);
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

      const responseBody = { success: true, received: req.body };
      _processedTransactions.set(String(req.body.transactionId), {
        eventType: String(eventType),
        processedAt: Date.now(),
        response: responseBody,
      });

      return res.status(200).json(responseBody);
    },
  );

  app.post(
    "/api/v1/webhooks/kyc",
    internalHmacAuth(options.kycSigningSecret || options.signingSecret),
    validateRequiredFields(["supplierId", "kycRef", "status"]),
    async (req: Request, res: Response) => {
      const provider = options.kycProvider || new MockKycProvider();

      try {
        const payload = provider.parseWebhook(req.body);
        const kycService = new KycService();
        await kycService.processWebhook(payload);

        return res.status(200).json({
          success: true,
          supplierId: payload.supplierId,
          kycStatus: payload.status,
          kycRef: payload.kycRef,
        });
      } catch (err: any) {
        if (err.message.includes("not found")) {
          return res.status(404).json({ success: false, error: err.message });
        }
        return res.status(400).json({ success: false, error: err.message });
      }
    }
  );
}

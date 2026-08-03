import { Router, Express, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";
import { _settlements } from "../services/settlementReconciler.js";
import { WebhookIdempotencyStore } from "../services/webhookIdempotencyStore.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  PartnerTokenSoftLimitService,
  processPendingDeliveries,
} from "../services/partnerTokenSoftLimitService.js";

const allowedEventTypes = new Set([
  "settlement_completed",
  "settlement_initiated",
  "settlement_failed",
]);

const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

export interface WebhookRouteOptions {
  signingSecret?: string;
  kycSigningSecret?: string;
  kycProvider?: any;
}

const handleSettlementWebhook = async (req: Request, res: Response) => {
  const { eventType, amount, timestamp } = req.body;
  const idempotencyKey = String(req.body.transactionId);
  const tenantId = req.headers["x-tenant-id"] ? String(req.headers["x-tenant-id"]) : "default";

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

  const isV1 = req.originalUrl && req.originalUrl.includes("/api/v1");
  if (isV1) {
    const ageMs = Date.now() - timestamp;
    if (ageMs > 5 * 60 * 1000 || ageMs < -CLOCK_SKEW_MS) {
      return res.status(403).json({
        success: false,
        error: "Rejected stale or future webhook payload.",
      });
    }
  }

  const existingResponse = await WebhookIdempotencyStore.getExistingResponse(tenantId, idempotencyKey);
  if (existingResponse) {
    return res.status(200).json(existingResponse);
  }

  const responseBody = { success: true, received: req.body };
  const saved = await WebhookIdempotencyStore.saveKey(tenantId, idempotencyKey, responseBody);
  
  if (!saved) {
    // If it wasn't saved, someone else just saved it concurrently.
    const concurrentResponse = await WebhookIdempotencyStore.getExistingResponse(tenantId, idempotencyKey);
    return res.status(200).json(concurrentResponse || responseBody);
  }

  if (eventType === "settlement_completed") {
    if (!_settlements.has(idempotencyKey)) {
      _settlements.set(idempotencyKey, {
        transactionId: idempotencyKey,
        eventType: String(eventType),
        amount: Number(amount),
        timestamp: Number(timestamp),
        status: "pending_finality",
        confirmations: 0,
        attempts: 0,
      });
    }
  }

  return res.status(200).json(responseBody);
};

const router = Router();
router.post(
  "/settlements",
  validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
  (req, res, next) => handleSettlementWebhook(req, res).catch(next),
);

// Admin inspection endpoint
router.get("/admin/idempotency/:tenantId/:idempotencyKey", async (req, res, next) => {
  try {
    const { tenantId, idempotencyKey } = req.params;
    const result = await WebhookIdempotencyStore.inspect(tenantId, idempotencyKey);
    if (!result) {
      return res.status(404).json({ success: false, error: "Key not found" });
    }
    await defaultAuditLogger.log({ action: 'webhook_idempotency.inspect', status: 'success', resource: `idempotencyKey:${idempotencyKey}`, metadata: { tenantId } });
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Admin sweep endpoint
router.post("/admin/idempotency/sweep", async (req, res, next) => {
  try {
    const deletedCount = await WebhookIdempotencyStore.sweep();
    await defaultAuditLogger.log({ action: 'webhook_idempotency.sweep', status: 'success', resource: 'system', metadata: { deletedCount } });
    return res.json({ success: true, deletedCount });
  } catch (err) {
    next(err);
  }
});

// Partner token soft-limit admin routes
router.post("/admin/partner-soft-limit", async (req, res, next) => {
  try {
    const { partnerId, webhookUrl, softLimit } = req.body;
    if (!partnerId || !webhookUrl) {
      return res.status(400).json({ success: false, error: "partnerId and webhookUrl are required" });
    }
    await PartnerTokenSoftLimitService.upsertConfig(partnerId, webhookUrl, softLimit);
    await defaultAuditLogger.log({
      action: "partner_soft_limit.configure",
      status: "success",
      resource: `partner:${partnerId}`,
      metadata: { softLimit, webhookUrl },
    });
    return res.json({ success: true });
  } catch (err: any) {
    if (err?.message) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
  }
});

router.get("/admin/partner-soft-limit/:partnerId", async (req, res, next) => {
  try {
    const { partnerId } = req.params;
    const config = await PartnerTokenSoftLimitService.getConfig(partnerId);
    if (!config) {
      return res.status(404).json({ success: false, error: "Partner config not found" });
    }
    return res.json({ success: true, data: config });
  } catch (err) {
    next(err);
  }
});

// Token usage check — soft-limit enqueue (also wired into quota consume path)
router.post("/partner-token/usage", async (req, res, next) => {
  try {
    const { partnerId, usage, hardCutoff } = req.body;
    if (!partnerId || typeof usage !== "number" || typeof hardCutoff !== "number") {
      return res.status(400).json({
        success: false,
        error: "partnerId, usage (number), and hardCutoff (number) are required",
      });
    }

    const entry = await PartnerTokenSoftLimitService.checkAndWarn(partnerId, usage, hardCutoff);
    if (entry) {
      return res.status(200).json({ success: true, warningEnqueued: true, entryId: entry.id });
    }
    return res.status(200).json({ success: true, warningEnqueued: false });
  } catch (err) {
    next(err);
  }
});

// Process pending/failed soft-limit deliveries (scheduler/cron)
router.post("/partner-token/deliver", async (req, res, next) => {
  try {
    const result = await processPendingDeliveries();
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;

export function registerWebhookRoutes(app: Express, options: WebhookRouteOptions = {}) {
  app.post(
    "/api/v1/webhooks/settlements",
    internalHmacAuth(options.signingSecret),
    validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
    (req, res, next) => handleSettlementWebhook(req, res).catch(next),
  );

  app.post(
    "/api/v1/webhooks/partner-token/check",
    internalHmacAuth(options.signingSecret),
    async (req, res, next) => {
      try {
        const { partnerId, usage, hardCutoff } = req.body;
        if (!partnerId || typeof usage !== "number" || typeof hardCutoff !== "number") {
          return res.status(400).json({
            success: false,
            error: "partnerId, usage (number), and hardCutoff (number) are required",
          });
        }
        const entry = await PartnerTokenSoftLimitService.checkAndWarn(
          partnerId,
          usage,
          hardCutoff,
        );
        if (entry) {
          return res.status(200).json({
            success: true,
            warningEnqueued: true,
            entryId: entry.id,
          });
        }
        return res.status(200).json({ success: true, warningEnqueued: false });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/api/v1/webhooks/partner-token/deliver",
    internalHmacAuth(options.signingSecret),
    async (_req, res, next) => {
      try {
        const result = await processPendingDeliveries();
        return res.json({ success: true, ...result });
      } catch (err) {
        next(err);
      }
    },
  );
}

export function _resetProcessedTransactions(): void {}


import { Router, Express, Request, Response, NextFunction } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";
import { _settlements } from "../services/settlementReconciler.js";
import { WebhookIdempotencyStore } from "../services/webhookIdempotencyStore.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  KycProvider,
  KycWebhookPayload,
  KycInvalidPayloadError,
  KycSupplierNotFoundError,
} from "../services/kycProvider.js";
import { MockKycProvider } from "../services/mockKycProvider.js";
import { kycService } from "../services/kycService.js";

const allowedEventTypes = new Set([
  "settlement_completed",
  "settlement_initiated",
  "settlement_failed",
]);

const CLOCK_SKEW_MS = 60 * 1000; // 1 minute

export interface WebhookRouteOptions {
  signingSecret?: string;
  kycSigningSecret?: string;
  kycProvider?: KycProvider;
}

const handleSettlementWebhook = async (req: Request, res: Response) => {
  const { eventType, amount, timestamp } = req.body;
  const idempotencyKey = String(req.body.transactionId);
  const tenantId = req.headers["x-tenant-id"] ? String(req.headers["x-tenant-id"]) : "default";

  if (!allowedEventTypes.has(eventType)) {
    return res.status(400).json({
      success: false,
      error:
        "Invalid eventType. Allowed values are settlement_completed, settlement_initiated, settlement_failed.",
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

  const existingResponse = await WebhookIdempotencyStore.getExistingResponse(
    tenantId,
    idempotencyKey,
  );
  if (existingResponse) {
    return res.status(200).json(existingResponse);
  }

  const responseBody = { success: true, received: req.body };
  const saved = await WebhookIdempotencyStore.saveKey(tenantId, idempotencyKey, responseBody);

  if (!saved) {
    // If it wasn't saved, someone else just saved it concurrently.
    const concurrentResponse = await WebhookIdempotencyStore.getExistingResponse(
      tenantId,
      idempotencyKey,
    );
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
    await defaultAuditLogger.log({
      action: "webhook_idempotency.inspect",
      status: "success",
      resource: `idempotencyKey:${idempotencyKey}`,
      metadata: { tenantId },
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// Admin sweep endpoint
router.post("/admin/idempotency/sweep", async (req, res, next) => {
  try {
    const deletedCount = await WebhookIdempotencyStore.sweep();
    await defaultAuditLogger.log({
      action: "webhook_idempotency.sweep",
      status: "success",
      resource: "system",
      metadata: { deletedCount },
    });
    return res.json({ success: true, deletedCount });
  } catch (err) {
    next(err);
  }
});

export default router;

/**
 * Handle a KYC provider verification event.
 *
 * The request body has already passed HMAC verification and required-field
 * validation before this handler runs. The pluggable `KycProvider` (default:
 * MockKycProvider) is responsible for parsing provider-specific payloads into
 * the canonical `KycWebhookPayload`.
 *
 * Failure semantics are explicit so providers can decide whether to retry:
 *  - 400  malformed payload (bad status, missing/invalid supplierId or kycRef)
 *  - 401  missing webhook signature
 *  - 403  invalid webhook signature
 *  - 404  supplier does not exist (terminal — do not retry)
 *  - 500  transient datastore error (safe to retry)
 *
 * Delivery is idempotent: re-applying the same status is a no-op state
 * transition and never re-grants reputation bootstrap (see
 * KycService.processWebhook).
 */
const handleKycWebhook = async (req: Request, res: Response, kycProvider?: KycProvider) => {
  const provider = kycProvider ?? new MockKycProvider();

  let payload: KycWebhookPayload;
  try {
    payload = provider.parseWebhook(req.body);
  } catch (err) {
    const message =
      err instanceof KycInvalidPayloadError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Invalid KYC webhook payload.";
    return res.status(400).json({ success: false, error: message });
  }

  try {
    const updated = await kycService.processWebhook(payload);
    if (!updated) {
      // Supplier existed at read time but was removed before the update
      // landed — treat as terminal, mirroring the not-found contract.
      return res.status(404).json({
        success: false,
        error: `Supplier with ID ${payload.supplierId} not found.`,
      });
    }
    return res.status(200).json({
      success: true,
      supplierId: payload.supplierId,
      kycStatus: payload.status,
      kycRef: payload.kycRef,
    });
  } catch (err) {
    if (err instanceof KycSupplierNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    throw err;
  }
};

export function registerWebhookRoutes(app: Express, options: WebhookRouteOptions = {}) {
  app.post(
    "/api/v1/webhooks/settlements",
    internalHmacAuth(options.signingSecret),
    validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
    (req, res, next) => handleSettlementWebhook(req, res).catch(next),
  );

  app.post(
    "/api/v1/webhooks/kyc",
    internalHmacAuth(options.kycSigningSecret ?? process.env.KYC_WEBHOOK_SECRET),
    validateRequiredFields(["supplierId", "kycRef", "status"]),
    (req: Request, res: Response, next: NextFunction) =>
      handleKycWebhook(req, res, options.kycProvider).catch(next),
  );
}

export function _resetProcessedTransactions(): void {}

import { Router, Express, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";
import { webhookRedeliveryAttempts, webhookRedeliveryHealth } from "../metrics.js";
import { _settlements } from "../services/settlementReconciler.js";
import { QuarantineStore } from "../services/quarantineStore.js";

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

interface WebhookRedeliveryState {
  endpoint: string;
  transactionId: string;
  attempts: number;
  processed: boolean;
  response?: { success: boolean; received: unknown };
  quarantined: boolean;
  quarantineId?: string;
  quarantinedAt?: number;
}

let _processedTransactions: Map<string, ProcessedEvent> = new Map();
let _webhookDeliveryStates: Map<string, WebhookRedeliveryState> = new Map();

export function _setProcessedTransactions(store: Map<string, ProcessedEvent>): void {
  _processedTransactions = store;
}

export function _resetProcessedTransactions(): void {
  _processedTransactions = new Map();
}

export function _setWebhookDeliveryStates(store: Map<string, WebhookRedeliveryState>): void {
  _webhookDeliveryStates = store;
}

export function _resetWebhookDeliveryStates(): void {
  _webhookDeliveryStates = new Map();
}

export interface WebhookRouteOptions {
  signingSecret?: string;
  kycSigningSecret?: string;
  kycProvider?: KycProvider;
  redeliveryMaxAttempts?: number;
  redeliveryMaxAttemptsByEndpoint?: Record<string, number>;
  quarantineStore?: QuarantineStore;
}

function resolveWebhookEndpoint(req: Request): string {
  const routePath = req.route?.path ?? req.originalUrl ?? req.path ?? "";
  if (routePath.includes("/kyc")) {
    return "kyc";
  }
  if (routePath.includes("/settlements")) {
    return "settlements";
  }
  return routePath || "default";
}

function getRedeliveryMaxAttempts(endpoint: string, options: WebhookRouteOptions): number {
  const endpointOverride = options.redeliveryMaxAttemptsByEndpoint?.[endpoint];
  if (typeof endpointOverride === "number" && Number.isFinite(endpointOverride) && endpointOverride > 0) {
    return endpointOverride;
  }

  if (typeof options.redeliveryMaxAttempts === "number" && Number.isFinite(options.redeliveryMaxAttempts) && options.redeliveryMaxAttempts > 0) {
    return options.redeliveryMaxAttempts;
  }

  const envValue = Number.parseInt(process.env.WEBHOOK_REDELIVERY_MAX_ATTEMPTS ?? "", 10);
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }

  return 3;
}

function updateRedeliveryMetrics(endpoint: string, state: WebhookRedeliveryState): void {
  webhookRedeliveryAttempts.labels(endpoint, state.quarantined ? "quarantined" : state.processed ? "processed" : "active").set(state.attempts);
  webhookRedeliveryHealth.labels(endpoint).set(state.quarantined ? 0 : 1);
}

const handleSettlementWebhook = (options: WebhookRouteOptions = {}) => (req: Request, res: Response) => {
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

  const endpoint = resolveWebhookEndpoint(req);
  const transactionId = String(req.body.transactionId);
  const maxAttempts = getRedeliveryMaxAttempts(endpoint, options);
  const stateKey = `${endpoint}:${transactionId}`;
  let state = _webhookDeliveryStates.get(stateKey);

  if (!state) {
    state = {
      endpoint,
      transactionId,
      attempts: 0,
      processed: false,
      quarantined: false,
    };
    _webhookDeliveryStates.set(stateKey, state);
  }

  state.attempts += 1;
  updateRedeliveryMetrics(endpoint, state);

  if (state.attempts > maxAttempts) {
    if (!state.quarantined) {
      state.quarantined = true;
      state.quarantinedAt = Date.now();
      state.quarantineId = `${endpoint}-${transactionId}-${state.attempts}`;
      const quarantineStore = options.quarantineStore ?? new QuarantineStore();
      quarantineStore.add({
        endpoint,
        transactionId,
        attempts: state.attempts,
        reason: "max_redelivery_attempts_exceeded",
      });
    }

    return res.status(429).json({
      success: false,
      error: "Webhook delivery quarantined after exceeding the configured redelivery attempts.",
      quarantineId: state.quarantineId,
    });
  }

  if (state.processed) {
    return res.status(200).json(state.response);
  }

  const responseBody = { success: true, received: req.body };
  state.processed = true;
  state.response = responseBody;
  updateRedeliveryMetrics(endpoint, state);

  _processedTransactions.set(transactionId, {
    eventType: String(eventType),
    processedAt: Date.now(),
    response: responseBody,
  });

  if (eventType === "settlement_completed") {
    if (!_settlements.has(String(req.body.transactionId))) {
      _settlements.set(String(req.body.transactionId), {
        transactionId: String(req.body.transactionId),
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
  handleSettlementWebhook(),
);

export default router;

export function registerWebhookRoutes(app: Express, options: WebhookRouteOptions = {}) {
  app.post(
    "/api/v1/webhooks/settlements",
    internalHmacAuth(options.signingSecret),
    validateRequiredFields(["eventType", "transactionId", "amount", "timestamp"]),
    handleSettlementWebhook(options),
  );
}

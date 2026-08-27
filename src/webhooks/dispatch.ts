// @ts-nocheck
/**
 * Supplier Calendar Sync – Webhook Dispatcher
 *
 * Emits `slot.changed` webhooks to suppliers containing the calendar payload
 * (start, duration, status) so they can sync into their own systems.
 *
 * The `calendar.mode` field indicates whether the change was an add, update,
 * or delete.
 *
 * Security & correctness guarantees:
 * - 4xx responses from receivers are NOT retried (the payload is invalid or
 *   the receiver explicitly rejects it).
 * - 5xx responses ARE retried per the outbound retry policy with exponential
 *   backoff and full jitter.
 * - Transactional rollback: if the upstream DB transaction rolls back, no
 *   webhook is dispatched (the caller must invoke `dispatchSlotChanged` only
 *   after a successful commit).
 */

import { createHmac } from "node:crypto";
import { timeoutConfig } from "../config/timeouts.js";
import { RetryPolicy } from "../utils/retry-policy.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";
import { SupplierCalendarSettingStore } from "../services/supplierCalendarSettingStore.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Calendar mode indicates the nature of the slot change. */
export type CalendarMode = "add" | "update" | "delete";

/** Status of a slot as exposed to suppliers. */
export type SlotStatus = "available" | "held" | "booked" | "cancelled";

/** The calendar payload included in every slot.changed webhook. */
export interface SlotCalendarPayload {
  /** Slot identifier. */
  slotId: number | string;
  /** Calendar mode: add, update, or delete. */
  mode: CalendarMode;
  /** Start time (epoch ms). */
  start: number;
  /** Duration in milliseconds. */
  duration: number;
  /** Slot status. */
  status: SlotStatus;
  /** Professional / provider name. */
  professional: string;
  /** End time (epoch ms). */
  end: number;
}

/** The full webhook event envelope sent to suppliers. */
export interface SlotChangedWebhookEvent {
  /** Always "slot.changed". */
  event: "slot.changed";
  /** ISO 8601 timestamp of when the event was produced. */
  timestamp: string;
  /** Unique idempotency key for this event (slotId + mode + version). */
  idempotencyKey: string;
  /** Calendar payload. */
  calendar: SlotCalendarPayload;
}

/** Options for the dispatch function. */
export interface DispatchSlotChangedOptions {
  /** Slot ID. */
  slotId: number | string;
  /** Calendar mode: add, update, or delete. */
  mode: CalendarMode;
  /** Start time (epoch ms). */
  start: number;
  /** End time (epoch ms). */
  end: number;
  /** Slot status. */
  status: SlotStatus;
  /** Professional / provider name. */
  professional: string;
  /** Supplier webhook endpoint URL. */
  webhookUrl: string;
  /** Supplier ID (for logging and idempotency). */
  supplierId: string;
  /** Signing secret for HMAC signature (optional). */
  signingSecret?: string;
  /** Monotonically increasing version for idempotency (default: Date.now()). */
  version?: number;
  /** Injected fetch function for testing (default: global fetch). */
  fetchFn?: typeof fetch;
}

/** Result of a dispatch attempt. */
export interface DispatchResult {
  /** Whether the dispatch succeeded (received a 2xx). */
  success: boolean;
  /** HTTP status code from the receiver (0 if network error). */
  statusCode: number;
  /** Error message if dispatch failed. */
  error?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const SLOT_CHANGED_EVENT = "slot.changed" as const;
const WEBHOOK_TIMEOUT_MS = timeoutConfig.http.webhookMs;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 */
function computeSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Build the slot.changed webhook event envelope.
 */
export function buildSlotChangedEvent(
  opts: Pick<DispatchSlotChangedOptions, "slotId" | "mode" | "start" | "end" | "status" | "professional"> & { version?: number }
): SlotChangedWebhookEvent {
  const { slotId, mode, start, end, status, professional, version } = opts;
  const duration = end - start;
  const ver = version ?? Date.now();

  return {
    event: SLOT_CHANGED_EVENT,
    timestamp: new Date().toISOString(),
    idempotencyKey: `${slotId}:${mode}:${ver}`,
    calendar: {
      slotId,
      mode,
      start,
      duration,
      status,
      professional,
      end,
    },
  };
}

/**
 * Determine if an HTTP status code is retryable (5xx).
 */
function isRetryableStatusCode(status: number): boolean {
  return status >= 500 && status < 600;
}

/**
 * Check if the supplier has calendar sync enabled.
 */
async function isSupplierOptedIn(supplierId: string): Promise<boolean> {
  return SupplierCalendarSettingStore.isEnabled(supplierId);
}

// ─── Main dispatch function ────────────────────────────────────────────────

/**
 * Dispatch a `slot.changed` webhook to a supplier's endpoint.
 *
 * Retries on 5xx / network errors per the outbound retry policy.
 * Does NOT retry on 4xx (invalid payload / explicit rejection).
 *
 * @returns DispatchResult indicating success or failure.
 */
export async function dispatchSlotChanged(
  opts: DispatchSlotChangedOptions,
): Promise<DispatchResult> {
  const {
    slotId,
    mode,
    start,
    end,
    status,
    professional,
    webhookUrl,
    supplierId,
    signingSecret,
    version,
    fetchFn = globalThis.fetch,
  } = opts;

  // ── Check supplier opt-in ──────────────────────────────────────────────
  const optedIn = await isSupplierOptedIn(supplierId);
  if (!optedIn) {
    logInfo("slot_webhook_skip", {
      slotId,
      supplierId,
      reason: "supplier_calendar_sync_disabled",
    });
    return { success: true, statusCode: 0, error: undefined };
  }

  // ── Build event ────────────────────────────────────────────────────────
  const event = buildSlotChangedEvent({
    slotId,
    mode,
    start,
    end,
    status,
    professional,
    version,
  });

  const body = JSON.stringify(event);

  // ── Sign payload ───────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Event": SLOT_CHANGED_EVENT,
    "X-Supplier-Id": supplierId,
  };

  if (signingSecret) {
    const signature = computeSignature(body, signingSecret);
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }

  // ── Dispatch with retry ────────────────────────────────────────────────
  const retryPolicy = new RetryPolicy({
    maxRetries: timeoutConfig.retry.maxAttempts - 1,
    initialDelay: timeoutConfig.retry.baseDelayMs,
    backoffFactor: 2,
    maxDelay: timeoutConfig.retry.maxTotalBudgetMs,
    useJitter: true,
  });

  const startTime = Date.now();

  try {
    const result = await retryPolicy.execute(
      async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        try {
          const response = await fetchFn(webhookUrl, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });

          // 4xx: do NOT retry — the receiver explicitly rejected or the payload is invalid
          if (response.status >= 400 && response.status < 500) {
            const errText = await response.text().catch(() => "unknown");
            logWarn("slot_webhook_4xx", {
              slotId,
              supplierId,
              statusCode: response.status,
              body: errText.slice(0, 500),
            });
            return { success: false, statusCode: response.status, error: `Receiver returned ${response.status}` } as DispatchResult;
          }

          // 5xx: retryable — throw to trigger retry
          if (response.status >= 500) {
            const errText = await response.text().catch(() => "unknown");
            throw new Error(`Receiver returned ${response.status}: ${errText.slice(0, 500)}`);
          }

          // 2xx success
          logInfo("slot_webhook_success", {
            slotId,
            supplierId,
            statusCode: response.status,
            duration: Date.now() - startTime,
          });

          return { success: true, statusCode: response.status } as DispatchResult;
        } finally {
          clearTimeout(timeoutId);
        }
      },
      (error: any) => {
        // Only retry on transient errors (5xx, network, timeout)
        // Do NOT retry on 4xx — those are handled inside the execute loop
        const message = (error?.message ?? "").toLowerCase();
        if (message.includes("receiver returned 4")) return false;
        return true;
      },
    );

    return result;
  } catch (error: any) {
    // All retries exhausted or unretryable error
    logError("slot_webhook_failed", {
      slotId,
      supplierId,
      error: error?.message ?? String(error),
      duration: Date.now() - startTime,
    });
    return {
      success: false,
      statusCode: 0,
      error: error?.message ?? String(error),
    };
  }
}

/**
 * Dispatch slot.changed webhooks to multiple suppliers.
 *
 * Returns a summary of results.
 */
export async function dispatchSlotChangedToAll(
  suppliers: Array<{ supplierId: string; webhookUrl: string }>,
  slotOpts: Omit<DispatchSlotChangedOptions, "webhookUrl" | "supplierId">,
): Promise<{ dispatched: number; succeeded: number; failed: number; results: DispatchResult[] }> {
  const results: DispatchResult[] = [];

  for (const supplier of suppliers) {
    const result = await dispatchSlotChanged({
      ...slotOpts,
      supplierId: supplier.supplierId,
      webhookUrl: supplier.webhookUrl,
    });
    results.push(result);
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    dispatched: results.length,
    succeeded,
    failed,
    results,
  };
}

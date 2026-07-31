import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../utils/logger.js";
import {
  supplierWebhookDispatched,
  supplierWebhookDeliveryErrors,
  supplierWebhookSkippedOptOut,
} from "../metrics.js";
import type { OutboxEvent } from "./outboxRelay.js";

const MAX_BACKOFF_MS = 60 * 60 * 1000; // cap at 1 hour
const BASE_BACKOFF_MS = 30 * 1000; // first retry after 30s
const DELIVERY_TIMEOUT_MS = 5_000;

interface QueryablePool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

class NotDueForRetryError extends Error {
  constructor(nextAttemptAt: Date) {
    super(`retry not due until ${nextAttemptAt.toISOString()}`);
    this.name = "NotDueForRetryError";
  }
}

function computeBackoffMs(attemptCount: number): number {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attemptCount);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time comparison helper, exported for tests that want to verify
 * signature verification logic without re-implementing HMAC comparison
 * unsafely (e.g. suppliers implementing their own verification).
 */
export function verifySignature(secret: string, rawBody: string, providedSignatureHex: string): boolean {
  const expected = signPayload(secret, rawBody);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(providedSignatureHex, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

async function getDeliveryState(
  pool: QueryablePool,
  outboxEventId: string,
): Promise<{ attemptCount: number; nextAttemptAt: Date | null }> {
  const result = await pool.query(
    `SELECT attempt_count, next_attempt_at FROM webhook_delivery_attempts WHERE outbox_event_id = $1`,
    [outboxEventId],
  );
  if (result.rows.length === 0) {
    return { attemptCount: 0, nextAttemptAt: null };
  }
  return {
    attemptCount: result.rows[0].attempt_count,
    nextAttemptAt: result.rows[0].next_attempt_at ? new Date(result.rows[0].next_attempt_at) : null,
  };
}

async function recordFailure(pool: QueryablePool, outboxEventId: string, attemptCount: number, error: string): Promise<void> {
  const nextAttemptCount = attemptCount + 1;
  const nextAttemptAt = new Date(Date.now() + computeBackoffMs(attemptCount));
  await pool.query(
    `INSERT INTO webhook_delivery_attempts (outbox_event_id, attempt_count, next_attempt_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (outbox_event_id)
     DO UPDATE SET attempt_count = $2, next_attempt_at = $3, last_error = $4, updated_at = NOW()`,
    [outboxEventId, nextAttemptCount, nextAttemptAt, error],
  );
}

async function clearFailure(pool: QueryablePool, outboxEventId: string): Promise<void> {
  await pool.query(`DELETE FROM webhook_delivery_attempts WHERE outbox_event_id = $1`, [outboxEventId]);
}

/**
 * Dispatches a single supplier-facing webhook outbox event.
 *
 * Called from the outbox relay's publish callback. Throws on any condition
 * that should leave the outbox row un-acked for a later retry (delivery
 * failure, backoff not yet elapsed); resolves normally for opted-out
 * suppliers or missing endpoints, since those are not retryable states.
 */
export async function dispatchSupplierWebhook(pool: QueryablePool, event: OutboxEvent): Promise<void> {
  const payload = event.payload as {
    slotId: string;
    start: string;
    timezone: string;
    reason: string;
    supplierId: string | null;
    occurredAt: string;
  };

  if (!payload.supplierId) {
    logger.warn({ eventId: event.id }, "slot.reservation.expired: no supplierId on payload, skipping");
    return;
  }

  const prefResult = await pool.query(
    `SELECT enabled FROM supplier_webhook_preferences WHERE supplier_id = $1 AND event_type = $2`,
    [payload.supplierId, event.event_type],
  );
  const enabled = prefResult.rows.length === 0 ? true : prefResult.rows[0].enabled;
  if (!enabled) {
    supplierWebhookSkippedOptOut.inc();
    return;
  }

  const endpointResult = await pool.query(
    `SELECT url, secret FROM supplier_webhook_endpoints WHERE supplier_id = $1`,
    [payload.supplierId],
  );
  if (endpointResult.rows.length === 0) {
    // No endpoint configured — not an error, nothing to deliver to.
    return;
  }
  const { url, secret } = endpointResult.rows[0];

  const { attemptCount, nextAttemptAt } = await getDeliveryState(pool, event.id);
  if (nextAttemptAt && nextAttemptAt.getTime() > Date.now()) {
    throw new NotDueForRetryError(nextAttemptAt);
  }

  const body = JSON.stringify({
    event: event.event_type,
    data: {
      slotId: payload.slotId,
      start: payload.start,
      timezone: payload.timezone,
      reason: payload.reason,
    },
    occurredAt: payload.occurredAt,
  });
  const signature = signPayload(secret, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ChronoPay-Event": event.event_type,
        "X-ChronoPay-Signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = `webhook endpoint responded with status ${response.status}`;
      await recordFailure(pool, event.id, attemptCount, message);
      supplierWebhookDeliveryErrors.inc();
      throw new Error(message);
    }

    await clearFailure(pool, event.id);
    supplierWebhookDispatched.inc();
  } catch (err) {
    if (err instanceof NotDueForRetryError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    await recordFailure(pool, event.id, attemptCount, message);
    supplierWebhookDeliveryErrors.inc();
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
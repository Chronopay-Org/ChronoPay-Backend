import { createHmac } from "node:crypto";
import type { OutboxEvent } from "./outboxRelay.js";
import { withTimeout } from "../utils/outbound-helper.js";
import { logger } from "../utils/logger.js";

/**
 * Pluggable publisher interface for the transactional outbox relay.
 * Implementations must resolve only when downstream delivery has succeeded
 * (so the relay can mark the row acked) and throw on failure (so the relay
 * retains the claim lease for retry and eventually dead-letters the row).
 */
export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<void>;
}

/**
 * Default log-only publisher used when no webhook URL is configured.
 */
export class LogOnlyOutboxPublisher implements OutboxPublisher {
  async publish(event: OutboxEvent): Promise<void> {
    logger.info(
      {
        eventId: event.id,
        eventType: event.event_type,
        aggregateId: event.aggregate_id,
      },
      "outbox relay: publishing event",
    );
  }
}

export interface HttpOutboxPublisherOptions {
  /** Target webhook URL (from OUTBOX_WEBHOOK_URL). */
  url: string;
  /** Optional HMAC-SHA256 signing secret (from OUTBOX_WEBHOOK_SECRET). */
  secret?: string;
  /** Request timeout in milliseconds (from OUTBOX_WEBHOOK_TIMEOUT_MS, default 5000). */
  timeoutMs?: number;
  /** Optional fetch implementation (primarily for testing). */
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * HTTP webhook outbox publisher.
 *
 * Sends a JSON POST with optional HMAC-SHA256 signature (`x-webhook-signature: sha256=<hex>`)
 * and throws on any non-2xx response or transport/timeout error so the outbox
 * relay does not acknowledge the event.
 */
export class HttpOutboxPublisher implements OutboxPublisher {
  private readonly url: string;
  private readonly secret?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpOutboxPublisherOptions) {
    if (!options.url || options.url.trim().length === 0) {
      throw new Error("HttpOutboxPublisher requires a non-empty url");
    }
    this.url = options.url.trim();
    this.secret = options.secret && options.secret.length > 0 ? options.secret : undefined;
    this.timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async publish(event: OutboxEvent): Promise<void> {
    const createdAt =
      event.created_at instanceof Date
        ? event.created_at.toISOString()
        : new Date(event.created_at).toISOString();

    const body = JSON.stringify({
      id: event.id,
      eventType: event.event_type,
      aggregateId: event.aggregate_id,
      payload: event.payload,
      createdAt,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-outbox-event-id": event.id,
      "x-outbox-event-type": event.event_type,
    };

    if (this.secret) {
      const signature = createHmac("sha256", this.secret).update(body).digest("hex");
      headers["x-webhook-signature"] = `sha256=${signature}`;
    }

    const response = await withTimeout(
      (signal) =>
        this.fetchFn(this.url, {
          method: "POST",
          headers,
          body,
          signal,
        }),
      this.timeoutMs,
      "outbox-webhook",
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `Outbox webhook HTTP ${response.status}${responseText ? `: ${responseText.slice(0, 200)}` : ""}`,
      );
    }
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Create the configured OutboxPublisher from environment variables.
 * Falls back to LogOnlyOutboxPublisher when OUTBOX_WEBHOOK_URL is unset.
 */
export function createOutboxPublisherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OutboxPublisher {
  const url = env.OUTBOX_WEBHOOK_URL?.trim();
  if (!url) {
    return new LogOnlyOutboxPublisher();
  }

  return new HttpOutboxPublisher({
    url,
    secret: env.OUTBOX_WEBHOOK_SECRET,
    timeoutMs: parsePositiveInt(env.OUTBOX_WEBHOOK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  });
}

// @ts-nocheck
/**
 * outboxRelay.ts
 *
 * Transactional outbox insert helper and async relay poller that guarantees
 * at-least-once delivery.
 *
 * Design decisions:
 *  - insertIntoOutbox is a plain SQL helper designed to be called within the
 *    same database transaction as the domain write so that the event and the
 *    business data are committed atomically.
 *  - The relay polls for un-acked rows, invokes the user-supplied publish
 *    callback, then marks the row as acked — all without a distributed
 *    transaction.  If the process crashes after publish but before the ack
 *    mark, the next poll cycle picks up the same row (at-least-once).
 *  - Publish callers are expected to be idempotent (e.g. Kafka produces
 *    with the outbox row id as the message key).
 *  - The relay respects an AbortSignal for clean shutdown.
 */

import { type PoolClient } from "pg";
import { logger } from "../utils/logger.js";
import {
  outboxRelayPublished,
  outboxRelayPublishErrors,
  outboxRelayDurationMs,
  outboxRelaySweepsTotal,
} from "../metrics.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface OutboxEvent {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
  acked_at: Date | null;
}

/**
 * Signature of the publish callback.
 * Receives a single outbox event and must resolve when the downstream consumer
 * has acknowledged receipt (or throw on failure).
 */
export type PublishFn = (event: OutboxEvent) => Promise<void>;

// ─── Insert helper ─────────────────────────────────────────────────────────────

/**
 * Insert a new outbox event inside the current database transaction.
 *
 * @example
 * ```ts
 * await withTransaction(async (client) => {
 *   await client.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [bookingId]);
 *   await insertIntoOutbox(client, "booking.confirmed", bookingId, { bookingId });
 * });
 * ```
 */
export async function insertIntoOutbox(
  client: PoolClient,
  eventType: string,
  aggregateId: string,
  payload: unknown,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_id, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [eventType, aggregateId, JSON.stringify(payload)],
  );
  return result.rows[0].id;
}

// ─── OutboxStore interface (production = SQL, tests = in-memory) ───────────────

export interface OutboxStore {
  /** Fetch the next batch of un-acked events, oldest first. */
  fetchUnacked(limit: number): Promise<OutboxEvent[]>;
  /** Mark a single event as acknowledged by its id. */
  markAcked(id: string): Promise<void>;
}

/**
 * Production SQL-backed outbox store.
 */
export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly pool: { query: Function }) {}

  async fetchUnacked(limit: number): Promise<OutboxEvent[]> {
    const result = await this.pool.query(
      `SELECT id, event_type, aggregate_id, payload, created_at, acked_at
       FROM outbox_events
       WHERE acked_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return result.rows;
  }

  async markAcked(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events SET acked_at = NOW() WHERE id = $1 AND acked_at IS NULL`,
      [id],
    );
  }
}

/**
 * In-memory outbox store for testing.
 */
export class InMemoryOutboxStore {
  private readonly rows = new Map<string, OutboxEvent>();

  upsert(row: OutboxEvent): void {
    this.rows.set(row.id, { ...row });
  }

  async fetchUnacked(limit: number): Promise<OutboxEvent[]> {
    const unacked = [...this.rows.values()]
      .filter((r) => r.acked_at === null)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit);
    return unacked;
  }

  async markAcked(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.acked_at = new Date();
    }
  }

  list(): OutboxEvent[] {
    return [...this.rows.values()];
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
  }

  size(): number {
    return this.rows.size;
  }
}

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface OutboxRelayConfig {
  /**
   * How many events to fetch in each poll cycle.  Defaults to 50
   * (OUTBOX_RELAY_BATCH_SIZE env var).
   */
  batchSize?: number;
  /**
   * How long the relay sleeps between polls in milliseconds.
   * Defaults to 3 000 ms / 3 seconds (OUTBOX_RELAY_INTERVAL_MS env var).
   */
  intervalMs?: number;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

function resolveConfig(
  overrides: OutboxRelayConfig = {},
): Required<OutboxRelayConfig> {
  return {
    batchSize:
      overrides.batchSize ??
      parsePositiveInteger(process.env.OUTBOX_RELAY_BATCH_SIZE, 50),
    intervalMs:
      overrides.intervalMs ??
      parsePositiveInteger(process.env.OUTBOX_RELAY_INTERVAL_MS, 3_000),
  };
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface OutboxRelayResult {
  /** Number of events successfully published and acked in this sweep. */
  published: number;
  /** Number of events that failed to publish (publish callback threw). */
  failed: number;
}

// ─── Core relay logic ──────────────────────────────────────────────────────────

/**
 * Perform a single relay sweep synchronously against the provided store.
 *
 * 1. Fetch up to `batchSize` un-acked events (oldest first).
 * 2. For each event, invoke the publish callback.
 * 3. On success, mark the event as acked.
 * 4. On failure, log the error and continue to the next event so a single
 *    poison-pill event does not block the entire queue.
 */
export async function relayOutboxOnce(
  store: OutboxStore,
  publish: PublishFn,
  config: OutboxRelayConfig = {},
): Promise<OutboxRelayResult> {
  const cfg = resolveConfig(config);
  const sweepStart = Date.now();

  const events = await store.fetchUnacked(cfg.batchSize);

  outboxRelaySweepsTotal.inc();

  if (events.length === 0) {
    outboxRelayDurationMs.observe(Date.now() - sweepStart);
    return { published: 0, failed: 0 };
  }

  let published = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await publish(event);
      await store.markAcked(event.id);
      published += 1;
    } catch (err) {
      failed += 1;
      outboxRelayPublishErrors.inc();
      logger.error(
        { eventId: event.id, eventType: event.event_type, error: err instanceof Error ? err.message : String(err) },
        "outbox relay: failed to publish event",
      );
    }
  }

  const elapsed = Date.now() - sweepStart;
  outboxRelayDurationMs.observe(elapsed);

  if (published > 0) {
    outboxRelayPublished.inc(published);
  }

  return { published, failed };
}

// ─── Long-running worker loop ─────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Continuously poll the outbox table, publish un-acked events, and mark them
 * as acknowledged, guaranteeing at-least-once delivery.
 *
 * @param signal  AbortSignal that stops the worker cleanly.
 * @param store   The outbox store to poll.
 * @param publish The publish callback that sends events to downstream consumers.
 * @param config  Optional configuration overrides.
 */
export async function runOutboxRelayWorker(
  signal: AbortSignal,
  store: OutboxStore,
  publish: PublishFn,
  config: OutboxRelayConfig = {},
): Promise<void> {
  const cfg = resolveConfig(config);

  while (!signal.aborted) {
    await relayOutboxOnce(store, publish, config);
    if (signal.aborted) break;
    await sleep(cfg.intervalMs, signal);
  }
}

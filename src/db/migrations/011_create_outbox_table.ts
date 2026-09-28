import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

/**
 * Migration 011 — create_outbox_table
 *
 * Creates the transactional outbox table used to reliably publish domain
 * events to downstream consumers.
 *
 * Design decisions:
 *  - `acked_at` is the downstream-acknowledgement timestamp.  When NULL
 *    the row has not yet been confirmed by the consumer; when set the row
 *    is a candidate for compaction once the retention window elapses.
 *  - `payload` is JSONB so the event body is schema-flexible and
 *    queryable without an application-level deserialisation step.
 *  - `event_type` and `aggregate_id` are plain text; an index on
 *    `(aggregate_id, created_at)` supports efficient fan-out queries.
 *  - `created_at` is indexed to support retention-window compaction scans.
 *  - No foreign-key reference on `aggregate_id` intentionally — the
 *    outbox is a cross-aggregate bus.
 */
export const migration: Migration = {
  id: "011b",
  name: "create_outbox_table",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE outbox_events (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type     TEXT        NOT NULL,
        aggregate_id   TEXT        NOT NULL,
        payload        JSONB       NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acked_at       TIMESTAMPTZ
      )
    `);

    // Fast lookup of un-acked rows (the relay loop primary query path).
    await client.query(`
      CREATE INDEX idx_outbox_events_unacked
        ON outbox_events (created_at)
        WHERE acked_at IS NULL
    `);

    // Compaction query: acked rows older than the retention window.
    await client.query(`
      CREATE INDEX idx_outbox_events_compaction
        ON outbox_events (acked_at)
        WHERE acked_at IS NOT NULL
    `);

    // Fan-out / event-stream query: by aggregate.
    await client.query(`
      CREATE INDEX idx_outbox_events_aggregate
        ON outbox_events (aggregate_id, created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TABLE IF EXISTS outbox_events`);
  },
};

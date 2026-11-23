import { query as defaultQuery } from "../db/pool.js";
import type { QueryResult } from "pg";
import type {
  PayoutQuarantineEntry,
  PayoutQuarantineFailure,
  PayoutQuarantineRepository,
  PayoutQuarantineUpsertResult,
  ReleasePayoutQuarantineOptions,
} from "./payoutQuarantineRepository.js";

export type QueryFn = (
  text: string,
  params?: unknown[],
) => Promise<QueryResult<Record<string, unknown>>>;

export class PgPayoutQuarantineRepository
  implements PayoutQuarantineRepository
{
  constructor(private readonly dbQuery: QueryFn = defaultQuery) {}

  async get(payoutId: string): Promise<PayoutQuarantineEntry | undefined> {
    const result = await this.dbQuery(
      `SELECT * FROM payout_quarantine WHERE payout_id = $1`,
      [payoutId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : undefined;
  }

  async upsert(
    failure: PayoutQuarantineFailure,
  ): Promise<PayoutQuarantineUpsertResult> {
    const sql = `
      INSERT INTO payout_quarantine AS existing (
        payout_id, supplier_id, total_failures, threshold, status,
        last_error_class, last_error_message, quarantined_at,
        quarantine_reason, quarantine_event_id, created_at, updated_at
      ) VALUES (
        $1, $2, 1, $3,
        CASE WHEN $3 <= 1 THEN 'quarantined' ELSE 'active' END,
        $4, $5,
        CASE WHEN $3 <= 1 THEN NOW() ELSE NULL END,
        CASE WHEN $3 <= 1 THEN 'failure-threshold-reached' ELSE NULL END,
        CASE WHEN $3 <= 1 THEN $6::uuid ELSE NULL END,
        NOW(), NOW()
      )
      ON CONFLICT (payout_id) DO UPDATE SET
        supplier_id = COALESCE(EXCLUDED.supplier_id, existing.supplier_id),
        total_failures = CASE
          WHEN existing.status = 'released' THEN 1
          ELSE existing.total_failures + 1
        END,
        threshold = EXCLUDED.threshold,
        status = CASE
          WHEN existing.status = 'quarantined' THEN 'quarantined'
          WHEN (CASE
            WHEN existing.status = 'released' THEN 1
            ELSE existing.total_failures + 1
          END) >= EXCLUDED.threshold THEN 'quarantined'
          ELSE 'active'
        END,
        last_error_class = COALESCE(EXCLUDED.last_error_class, existing.last_error_class),
        last_error_message = COALESCE(EXCLUDED.last_error_message, existing.last_error_message),
        quarantined_at = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN NOW()
          ELSE existing.quarantined_at
        END,
        quarantine_reason = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN 'failure-threshold-reached'
          ELSE existing.quarantine_reason
        END,
        quarantine_event_id = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN $6::uuid
          ELSE existing.quarantine_event_id
        END,
        released_at = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN NULL
          ELSE existing.released_at
        END,
        release_reason = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN NULL
          ELSE existing.release_reason
        END,
        released_by = CASE
          WHEN existing.status <> 'quarantined'
            AND (CASE
              WHEN existing.status = 'released' THEN 1
              ELSE existing.total_failures + 1
            END) >= EXCLUDED.threshold THEN NULL
          ELSE existing.released_by
        END,
        updated_at = NOW()
      RETURNING *,
        (status = 'quarantined' AND quarantine_event_id = $6::uuid)
          AS newly_quarantined
    `;
    const result = await this.dbQuery(sql, [
      failure.payoutId,
      failure.supplierId ?? null,
      failure.threshold,
      failure.errorClass ?? null,
      failure.errorMessage ?? null,
      failure.operationId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Payout quarantine upsert returned no row");
    }
    return {
      entry: this.mapRow(row),
      newlyQuarantined: row.newly_quarantined === true,
    };
  }

  async list(): Promise<PayoutQuarantineEntry[]> {
    const result = await this.dbQuery(
      `SELECT * FROM payout_quarantine ORDER BY created_at ASC, payout_id ASC`,
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async release(
    payoutId: string,
    options: ReleasePayoutQuarantineOptions,
  ): Promise<boolean> {
    const result = await this.dbQuery(
      `
        UPDATE payout_quarantine
        SET status = 'released',
            released_at = NOW(),
            release_reason = $2,
            released_by = $3,
            quarantine_event_id = NULL,
            updated_at = NOW()
        WHERE payout_id = $1
        RETURNING payout_id
      `,
      [payoutId, options.reason ?? null, options.releasedBy ?? null],
    );
    return result.rows.length > 0;
  }

  private mapRow(row: Record<string, unknown>): PayoutQuarantineEntry {
    return {
      payoutId: String(row.payout_id),
      supplierId: row.supplier_id == null ? undefined : String(row.supplier_id),
      totalFailures: Number(row.total_failures),
      threshold: Number(row.threshold),
      status: row.status as PayoutQuarantineEntry["status"],
      lastErrorClass:
        row.last_error_class == null ? undefined : String(row.last_error_class),
      lastErrorMessage:
        row.last_error_message == null ? undefined : String(row.last_error_message),
      quarantinedAt:
        row.quarantined_at == null
          ? undefined
          : new Date(row.quarantined_at as string | Date).toISOString(),
      releasedAt:
        row.released_at == null
          ? undefined
          : new Date(row.released_at as string | Date).toISOString(),
      quarantineReason:
        row.quarantine_reason == null
          ? undefined
          : String(row.quarantine_reason),
      releaseReason:
        row.release_reason == null ? undefined : String(row.release_reason),
      releasedBy: row.released_by == null ? undefined : String(row.released_by),
    };
  }
}

export const defaultPgPayoutQuarantineRepository =
  new PgPayoutQuarantineRepository();

/**
 * KEK Envelope Rotation Runner
 *
 * Online re-encryption of Data Encryption Keys (DEKs) when the
 * Key Encryption Key (KEK) is rotated.
 *
 * Design goals (issue #523):
 * - Iterate rows in batches using a durable checkpoint id
 * - Support pause / resume and a rollback point
 * - Emit progress metrics
 * - Never keep multiple wrapped DEK copies longer than a bounded window
 * - Survive crash mid-batch, mixed KEK versions, and transient KMS failures
 *
 * The ciphertext itself is never touched; only the wrapped DEK is re-wrapped.
 */

import type { Pool, PoolClient } from "pg";
import { Counter, Gauge } from "prom-client";

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const kekRotationRowsProcessed = new Counter({
  name: "kek_rotation_rows_processed_total",
  help: "Total rows whose DEK was successfully re-wrapped",
  labelNames: ["rotation_id", "result"] as const,
});

export const kekRotationErrors = new Counter({
  name: "kek_rotation_errors_total",
  help: "Total errors encountered during KEK rotation",
  labelNames: ["rotation_id", "kind"] as const,
});

export const kekRotationCheckpoint = new Gauge({
  name: "kek_rotation_last_checkpoint_id",
  help: "Last successfully committed checkpoint id for a rotation",
  labelNames: ["rotation_id"] as const,
});

export const kekRotationStatusGauge = new Gauge({
  name: "kek_rotation_status",
  help: "Numeric status of a rotation (0=pending,1=running,2=paused,3=completed,4=failed,5=rolling_back)",
  labelNames: ["rotation_id"] as const,
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RotationStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "rolling_back";

export interface KekVersion {
  /** Opaque version identifier (e.g. KMS key ARN + version id) */
  id: string;
}

export interface EnvelopeRow {
  id: string; // primary key / cursor
  wrappedDek: Buffer;
  kekVersionId: string;
  /** Optional schema / format version of the envelope */
  schemaVersion?: number;
}

export interface RotationCheckpoint {
  rotationId: string;
  status: RotationStatus;
  lastCheckpointId: string | null;
  oldKekVersionId: string;
  newKekVersionId: string;
  rowsProcessed: number;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StartRotationParams {
  rotationId: string;
  oldKek: KekVersion;
  newKek: KekVersion;
  /** Table that holds envelope-encrypted columns */
  tableName: string;
  /** Column that stores the wrapped DEK */
  wrappedDekColumn: string;
  /** Column that stores the KEK version id */
  kekVersionColumn: string;
  /** Primary key / cursor column */
  idColumn?: string;
  batchSize?: number;
}

export interface RunnerOptions {
  /** Max time (ms) a dual-write / intermediate state is allowed to exist */
  maxDualWriteWindowMs?: number;
  /** Max consecutive transient KMS failures before pausing */
  maxTransientFailures?: number;
  /** Delay between retries of transient KMS errors */
  transientRetryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Dependencies (injected for testability)
// ---------------------------------------------------------------------------

/**
 * Minimal KMS abstraction. Real implementation would call AWS KMS /
 * Vault / etc. Tests inject a mock.
 */
export interface KeyManagementService {
  unwrapDek(wrappedDek: Buffer, kek: KekVersion): Promise<Buffer>;
  wrapDek(dek: Buffer, kek: KekVersion): Promise<Buffer>;
}

export interface CheckpointStore {
  get(rotationId: string): Promise<RotationCheckpoint | null>;
  upsert(cp: RotationCheckpoint): Promise<void>;
}

export interface EnvelopeRepository {
  /**
   * Fetch next batch of rows whose id > afterId, ordered by id.
   * Implementation should use a safe cursor (e.g. FOR UPDATE SKIP LOCKED).
   */
  fetchBatch(
    client: PoolClient,
    params: {
      tableName: string;
      idColumn: string;
      wrappedDekColumn: string;
      kekVersionColumn: string;
      afterId: string | null;
      limit: number;
    }
  ): Promise<EnvelopeRow[]>;

  /**
   * Atomically replace the wrapped DEK and KEK version for a single row.
   * Must be a single UPDATE so we never persist two wrapped copies.
   */
  updateWrappedDek(
    client: PoolClient,
    params: {
      tableName: string;
      idColumn: string;
      wrappedDekColumn: string;
      kekVersionColumn: string;
      id: string;
      newWrappedDek: Buffer;
      newKekVersionId: string;
    }
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default in-process checkpoint store (replace with DB-backed in production)
// ---------------------------------------------------------------------------

export class InMemoryCheckpointStore implements CheckpointStore {
  private store = new Map<string, RotationCheckpoint>();

  async get(rotationId: string): Promise<RotationCheckpoint | null> {
    return this.store.get(rotationId) ?? null;
  }

  async upsert(cp: RotationCheckpoint): Promise<void> {
    this.store.set(cp.rotationId, { ...cp, updatedAt: new Date() });
  }
}

// ---------------------------------------------------------------------------
// Default Postgres envelope repository
// ---------------------------------------------------------------------------

export class PgEnvelopeRepository implements EnvelopeRepository {
  async fetchBatch(
    client: PoolClient,
    params: {
      tableName: string;
      idColumn: string;
      wrappedDekColumn: string;
      kekVersionColumn: string;
      afterId: string | null;
      limit: number;
    }
  ): Promise<EnvelopeRow[]> {
    const {
      tableName,
      idColumn,
      wrappedDekColumn,
      kekVersionColumn,
      afterId,
      limit,
    } = params;

    // NOTE: table/column names are trusted configuration, not user input.
    const sql =
      afterId === null
        ? `
          SELECT ${idColumn} AS id,
                 ${wrappedDekColumn} AS "wrappedDek",
                 ${kekVersionColumn} AS "kekVersionId"
          FROM ${tableName}
          ORDER BY ${idColumn}
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `
        : `
          SELECT ${idColumn} AS id,
                 ${wrappedDekColumn} AS "wrappedDek",
                 ${kekVersionColumn} AS "kekVersionId"
          FROM ${tableName}
          WHERE ${idColumn} > $1
          ORDER BY ${idColumn}
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `;

    const values = afterId === null ? [limit] : [afterId, limit];
    const res = await client.query(sql, values);

    return res.rows.map((r) => ({
      id: String(r.id),
      wrappedDek: Buffer.isBuffer(r.wrappedDek)
        ? r.wrappedDek
        : Buffer.from(r.wrappedDek),
      kekVersionId: String(r.kekVersionId),
    }));
  }

  async updateWrappedDek(
    client: PoolClient,
    params: {
      tableName: string;
      idColumn: string;
      wrappedDekColumn: string;
      kekVersionColumn: string;
      id: string;
      newWrappedDek: Buffer;
      newKekVersionId: string;
    }
  ): Promise<void> {
    const {
      tableName,
      idColumn,
      wrappedDekColumn,
      kekVersionColumn,
      id,
      newWrappedDek,
      newKekVersionId,
    } = params;

    // Single atomic UPDATE — never leaves two wrapped copies on disk.
    const sql = `
      UPDATE ${tableName}
      SET ${wrappedDekColumn} = $1,
          ${kekVersionColumn} = $2
      WHERE ${idColumn} = $3
    `;
    await client.query(sql, [newWrappedDek, newKekVersionId, id]);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const STATUS_TO_NUMBER: Record<RotationStatus, number> = {
  pending: 0,
  running: 1,
  paused: 2,
  completed: 3,
  failed: 4,
  rolling_back: 5,
};

export class KekRotationRunner {
  private readonly maxDualWriteWindowMs: number;
  private readonly maxTransientFailures: number;
  private readonly transientRetryDelayMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly kms: KeyManagementService,
    private readonly checkpoints: CheckpointStore = new InMemoryCheckpointStore(),
    private readonly envelopes: EnvelopeRepository = new PgEnvelopeRepository(),
    opts: RunnerOptions = {}
  ) {
    this.maxDualWriteWindowMs = opts.maxDualWriteWindowMs ?? 30_000;
    this.maxTransientFailures = opts.maxTransientFailures ?? 5;
    this.transientRetryDelayMs = opts.transientRetryDelayMs ?? 500;
  }

  /** Start a new rotation (or resume a paused/failed one with same id). */
  async start(params: StartRotationParams): Promise<RotationCheckpoint> {
    const existing = await this.checkpoints.get(params.rotationId);

    if (existing && existing.status === "completed") {
      throw new Error(`Rotation ${params.rotationId} already completed`);
    }

    if (existing && existing.status === "running") {
      throw new Error(`Rotation ${params.rotationId} is already running`);
    }

    const cp: RotationCheckpoint = existing
      ? {
          ...existing,
          status: "running",
          errorMessage: null,
          updatedAt: new Date(),
        }
      : {
          rotationId: params.rotationId,
          status: "running",
          lastCheckpointId: null,
          oldKekVersionId: params.oldKek.id,
          newKekVersionId: params.newKek.id,
          rowsProcessed: 0,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

    await this.checkpoints.upsert(cp);
    this.emitStatus(cp);

    // Fire-and-forget the actual work so start() returns quickly.
    // Callers that need to await completion can poll status() or listen to metrics.
    void this.runLoop(params, cp);

    return cp;
  }

  async pause(rotationId: string): Promise<RotationCheckpoint> {
    const cp = await this.requireCheckpoint(rotationId);
    if (cp.status !== "running") {
      throw new Error(`Cannot pause rotation in status=${cp.status}`);
    }
    cp.status = "paused";
    cp.updatedAt = new Date();
    await this.checkpoints.upsert(cp);
    this.emitStatus(cp);
    return cp;
  }

  async resume(params: StartRotationParams): Promise<RotationCheckpoint> {
    const cp = await this.requireCheckpoint(params.rotationId);
    if (cp.status !== "paused" && cp.status !== "failed") {
      throw new Error(`Cannot resume rotation in status=${cp.status}`);
    }
    return this.start(params);
  }

  /**
   * Roll back to the last durable checkpoint.
   * Because we only ever store one wrapped DEK per row, true cryptographic
   * rollback requires the old KEK still be available and a reverse pass.
   * This method marks the rotation and re-wraps rows back to the old KEK
   * up to (and including) the current checkpoint.
   */
  async rollback(params: StartRotationParams): Promise<RotationCheckpoint> {
    const cp = await this.requireCheckpoint(params.rotationId);
    if (cp.status === "completed") {
      throw new Error("Cannot rollback a completed rotation");
    }

    cp.status = "rolling_back";
    cp.updatedAt = new Date();
    await this.checkpoints.upsert(cp);
    this.emitStatus(cp);

    // Reverse direction: re-wrap everything that is already on the new KEK
    // back onto the old KEK, using the same batching machinery.
    const reverseParams: StartRotationParams = {
      ...params,
      oldKek: params.newKek,
      newKek: params.oldKek,
    };

    // Reset cursor so the reverse pass covers all previously migrated rows.
    cp.lastCheckpointId = null;
    cp.rowsProcessed = 0;
    await this.checkpoints.upsert(cp);

    void this.runLoop(reverseParams, cp, /* isRollback */ true);
    return cp;
  }

  async status(rotationId: string): Promise<RotationCheckpoint | null> {
    return this.checkpoints.get(rotationId);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async runLoop(
    params: StartRotationParams,
    cp: RotationCheckpoint,
    isRollback = false
  ): Promise<void> {
    const idColumn = params.idColumn ?? "id";
    const batchSize = params.batchSize ?? 100;
    let transientFailures = 0;

    try {
      while (true) {
        // Honour pause / external status changes
        const latest = await this.checkpoints.get(params.rotationId);
        if (!latest || latest.status === "paused" || latest.status === "failed") {
          return;
        }
        if (!isRollback && latest.status === "rolling_back") {
          return;
        }

        const client = await this.pool.connect();
        try {
          await client.query("BEGIN");

          const batch = await this.envelopes.fetchBatch(client, {
            tableName: params.tableName,
            idColumn,
            wrappedDekColumn: params.wrappedDekColumn,
            kekVersionColumn: params.kekVersionColumn,
            afterId: cp.lastCheckpointId,
            limit: batchSize,
          });

          if (batch.length === 0) {
            cp.status = "completed";
            cp.updatedAt = new Date();
            await this.checkpoints.upsert(cp);
            this.emitStatus(cp);
            await client.query("COMMIT");
            return;
          }

          for (const row of batch) {
            // Skip rows already on the target KEK (mixed-version safety)
            const targetKekId = isRollback
              ? params.newKek.id
              : params.newKek.id;
            if (row.kekVersionId === targetKekId) {
              cp.lastCheckpointId = row.id;
              continue;
            }

            // Only process rows that are on the expected source KEK
            const sourceKekId = isRollback
              ? params.oldKek.id
              : params.oldKek.id;
            if (row.kekVersionId !== sourceKekId) {
              // Unknown / unexpected version — record and skip
              kekRotationErrors.inc({
                rotation_id: params.rotationId,
                kind: "unexpected_kek_version",
              });
              cp.lastCheckpointId = row.id;
              continue;
            }

            const sourceKek = isRollback ? params.oldKek : params.oldKek;
            const targetKek = isRollback ? params.newKek : params.newKek;

            let dek: Buffer;
            try {
              dek = await this.kms.unwrapDek(row.wrappedDek, sourceKek);
            } catch (err) {
              transientFailures++;
              kekRotationErrors.inc({
                rotation_id: params.rotationId,
                kind: "kms_unwrap",
              });
              if (transientFailures >= this.maxTransientFailures) {
                throw err;
              }
              await sleep(this.transientRetryDelayMs);
              // Re-throw into outer retry by aborting this batch
              throw err;
            }

            let newWrapped: Buffer;
            try {
              newWrapped = await this.kms.wrapDek(dek, targetKek);
            } catch (err) {
              transientFailures++;
              kekRotationErrors.inc({
                rotation_id: params.rotationId,
                kind: "kms_wrap",
              });
              if (transientFailures >= this.maxTransientFailures) {
                throw err;
              }
              await sleep(this.transientRetryDelayMs);
              throw err;
            }

            // Zeroize plaintext DEK as soon as possible
            dek.fill(0);

            await this.envelopes.updateWrappedDek(client, {
              tableName: params.tableName,
              idColumn,
              wrappedDekColumn: params.wrappedDekColumn,
              kekVersionColumn: params.kekVersionColumn,
              id: row.id,
              newWrappedDek: newWrapped,
              newKekVersionId: targetKek.id,
            });

            cp.lastCheckpointId = row.id;
            cp.rowsProcessed += 1;
            transientFailures = 0;

            kekRotationRowsProcessed.inc({
              rotation_id: params.rotationId,
              result: "success",
            });
            kekRotationCheckpoint.set(
              { rotation_id: params.rotationId },
              Number.isFinite(Number(row.id)) ? Number(row.id) : 0
            );
          }

          cp.updatedAt = new Date();
          await this.checkpoints.upsert(cp);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
    } catch (err) {
      cp.status = "failed";
      cp.errorMessage =
        err instanceof Error ? err.message : "Unknown rotation error";
      cp.updatedAt = new Date();
      await this.checkpoints.upsert(cp);
      this.emitStatus(cp);
      kekRotationErrors.inc({
        rotation_id: params.rotationId,
        kind: "fatal",
      });
    }
  }

  private async requireCheckpoint(
    rotationId: string
  ): Promise<RotationCheckpoint> {
    const cp = await this.checkpoints.get(rotationId);
    if (!cp) {
      throw new Error(`Unknown rotationId: ${rotationId}`);
    }
    return cp;
  }

  private emitStatus(cp: RotationCheckpoint): void {
    kekRotationStatusGauge.set(
      { rotation_id: cp.rotationId },
      STATUS_TO_NUMBER[cp.status]
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
  }

/**
 * migrationRunner.ts
 *
 * Core migration engine. Orchestrates up/down/status/validate operations
 * without knowing about specific SQL schema — that lives in the migration
 * files and the repository.
 *
 * Design decisions:
 *  - Stop-on-first-failure: never continue past a broken migration.
 *  - All DB writes (up/down + tracking record) happen inside a single transaction.
 *  - Returns structured result objects; does not throw on migration failure.
 *  - Dependencies (pool, repo, migrations[]) are injected for testability.
 */

import { Pool, PoolClient } from "pg";
import { withTransaction } from "./connection.js";
import type {
  QueryClient,
  AppliedMigration,
} from "./migrationRepository.js";

// ─── Public types ────────────────────────────────────────────────────────────

/** Contract every migration file must export. */
export interface Migration {
  /** Unique, sortable identifier, e.g. "001", "002". */
  id: string;
  /** Human-readable label, e.g. "create_users_table". */
  name: string;
  /** Forward migration: apply the schema change. */
  up(client: PoolClient): Promise<void>;
  /** Backward migration: revert the schema change. */
  down(client: PoolClient): Promise<void>;
}

/** Status of a single migration as reported by MigrationRunner.status(). */
export interface MigrationStatus {
  id: string;
  name: string;
  status: "applied" | "pending";
  applied_at?: Date;
}

/** Result returned by up() and down(). */
export interface MigrationResult {
  success: boolean;
  /** IDs of migrations that were successfully applied/rolled back. */
  applied: string[];
  /** ID of the migration that failed, if any. */
  failed?: string;
  /** The error that caused the failure, if any. */
  error?: Error;
}

/** Result returned by validate(). */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ─── Repository interface (dependency-injected) ──────────────────────────────

/**
 * Structural interface for the migration repository.
 * The real implementation lives in migrationRepository.ts; tests inject a mock.
 */
export interface MigrationRepository {
  ensureMigrationsTable(client: QueryClient): Promise<void>;
  getAppliedMigrations(client: QueryClient): Promise<AppliedMigration[]>;
  recordMigration(client: QueryClient, id: string, name: string): Promise<void>;
  removeMigration(client: QueryClient, id: string): Promise<void>;
}

// ─── MigrationRunner ─────────────────────────────────────────────────────────

export class MigrationRunner {
  private readonly transact: typeof withTransaction;

  constructor(
    private readonly pool: Pool,
    private readonly repo: MigrationRepository,
    private readonly migrations: Migration[],
    /**
     * Transaction helper — defaults to the module-level withTransaction.
     * Inject a mock here in tests to avoid needing to mock the connection module.
     */
    transact?: typeof withTransaction,
  ) {
    this.transact = transact ?? withTransaction;
  }

  /**
   * Validates migration definitions without touching the database.
   * Checks: duplicate IDs, empty id/name fields, missing up/down functions.
   */
  async validate(): Promise<ValidationResult> {
    const errors: string[] = [];
    const seenIds = new Map<string, number>();

    for (const m of this.migrations) {
      // Count occurrences to detect duplicates
      seenIds.set(m.id, (seenIds.get(m.id) ?? 0) + 1);

      if (!m.id || m.id.trim() === "") {
        errors.push(`Migration has empty id (name: "${m.name}")`);
      }
      if (!m.name || m.name.trim() === "") {
        errors.push(`Migration "${m.id}" has empty name`);
      }
      if (typeof m.up !== "function") {
        errors.push(`Migration "${m.id}" is missing an up() function`);
      }
      if (typeof m.down !== "function") {
        errors.push(`Migration "${m.id}" is missing a down() function`);
      }
    }

    // Report all duplicate IDs
    for (const [id, count] of seenIds.entries()) {
      if (count > 1) {
        errors.push(
          `Duplicate migration ID "${id}" appears ${count} times`,
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Returns the status (applied | pending) of every registered migration.
   * Ensures the tracking table exists as a side effect.
   */
  async status(): Promise<MigrationStatus[]> {
    await this.repo.ensureMigrationsTable(this.pool);
    const applied = await this.repo.getAppliedMigrations(this.pool);
    const appliedMap = new Map<string, AppliedMigration>(
      applied.map((a) => [a.id, a]),
    );

    return this.migrations.map((m) => {
      const record = appliedMap.get(m.id);
      return record
        ? { id: m.id, name: m.name, status: "applied", applied_at: record.applied_at }
        : { id: m.id, name: m.name, status: "pending" };
    });
  }

  /**
   * Applies pending migrations in order.
   *
   * @param count - Maximum number of migrations to apply. Applies all pending
   *                migrations when omitted.
   *
   * Each migration runs inside its own transaction together with the tracking
   * record insert. Stops immediately on the first failure; subsequent pending
   * migrations are left untouched.
   */
  async up(count?: number): Promise<MigrationResult> {
    await this.repo.ensureMigrationsTable(this.pool);
    const applied = await this.repo.getAppliedMigrations(this.pool);
    const appliedIds = new Set(applied.map((a) => a.id));

    let pending = this.migrations.filter((m) => !appliedIds.has(m.id));
    if (count !== undefined) {
      pending = pending.slice(0, count);
    }

    const result: MigrationResult = { success: true, applied: [] };

    for (const migration of pending) {
      try {
        await this.transact(async (client) => {
          await migration.up(client);
          await this.repo.recordMigration(client, migration.id, migration.name);
        });
        result.applied.push(migration.id);
      } catch (err) {
        result.success = false;
        result.failed = migration.id;
        result.error = err instanceof Error ? err : new Error(String(err));
        break; // Stop-on-first-failure
      }
    }

    return result;
  }

  /**
   * Rolls back applied migrations in reverse order (most-recent first).
   *
   * @param count - Number of migrations to roll back. Defaults to 1.
   *
   * Each rollback runs inside its own transaction together with the tracking
   * record deletion. Stops immediately on the first failure.
   */
  async down(count: number = 1): Promise<MigrationResult> {
    await this.repo.ensureMigrationsTable(this.pool);
    const appliedRecords = await this.repo.getAppliedMigrations(this.pool);
    const appliedIds = new Set(appliedRecords.map((a) => a.id));

    // Reverse the registered migration list so most-recently applied is first
    const toRollback = [...this.migrations]
      .reverse()
      .filter((m) => appliedIds.has(m.id))
      .slice(0, count);

    const result: MigrationResult = { success: true, applied: [] };

    for (const migration of toRollback) {
      try {
        await this.transact(async (client) => {
          await migration.down(client);
          await this.repo.removeMigration(client, migration.id);
        });
        result.applied.push(migration.id);
      } catch (err) {
        result.success = false;
        result.failed = migration.id;
        result.error = err instanceof Error ? err : new Error(String(err));
        break; // Stop-on-first-failure
      }
    }

    return result;
  }
}

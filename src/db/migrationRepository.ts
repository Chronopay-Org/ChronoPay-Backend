/**
 * migrationRepository.ts
 *
 * All SQL interactions with the `schema_migrations` tracking table.
 * Functions accept a structural `QueryClient` so both `Pool` (for bootstrap
 * operations outside a transaction) and `PoolClient` (inside a transaction)
 * can be passed without any casting.
 */

/** Minimal interface satisfied by both Pool and PoolClient. */
export interface QueryClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Shape of a row returned from schema_migrations. */
export interface AppliedMigration {
  id: string;
  name: string;
  applied_at: Date;
}

/**
 * Creates the `schema_migrations` table if it does not already exist.
 * Safe to call on every application start — idempotent.
 */
export async function ensureMigrationsTable(
  client: QueryClient,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         VARCHAR(255) PRIMARY KEY,
      name       VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Returns all rows from schema_migrations, ordered by id ascending.
 * The ascending order is important — callers rely on it to determine the
 * most-recently applied migration when rolling back.
 */
export async function getAppliedMigrations(
  client: QueryClient,
): Promise<AppliedMigration[]> {
  const result = await client.query(
    `SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC`,
  );
  return result.rows.map((row) => ({
    id: row["id"] as string,
    name: row["name"] as string,
    applied_at: row["applied_at"] as Date,
  }));
}

/**
 * Inserts a row recording that a migration has been applied.
 * Uses parameterized query to prevent SQL injection.
 */
export async function recordMigration(
  client: QueryClient,
  id: string,
  name: string,
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migrations (id, name) VALUES ($1, $2)`,
    [id, name],
  );
}

/**
 * Deletes the row for the given migration id, used during rollback.
 * Uses parameterized query to prevent SQL injection.
 */
export async function removeMigration(
  client: QueryClient,
  id: string,
): Promise<void> {
  await client.query(`DELETE FROM schema_migrations WHERE id = $1`, [id]);
}

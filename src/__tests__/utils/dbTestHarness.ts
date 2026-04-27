import { getPool } from "../../db/connection.js";
import { MigrationRunner } from "../../db/migrationRunner.js";
import * as repo from "../../db/migrationRepository.js";
import { migrations } from "../../db/migrations/index.js";

/**
 * Validates that the current environment is safe for destructive test operations.
 * Throws an error if we are not in a test environment or if the database URL
 * doesn't explicitly look like a test database.
 */
function assertSafeTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `Security Error: DB Test Harness cannot run in NODE_ENV=${process.env.NODE_ENV}. It must be "test".`
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Security Error: DATABASE_URL is not set.");
  }

  if (!url.toLowerCase().includes("test")) {
    throw new Error(
      "Security Error: DATABASE_URL does not appear to be a test database. It must contain 'test'."
    );
  }
}

/**
 * Drops the public schema and recreates it. This gives a completely clean
 * database state.
 *
 * ONLY RUNS if assertSafeTestEnvironment() passes.
 */
export async function setupCleanDb(): Promise<void> {
  assertSafeTestEnvironment();
  const pool = getPool();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

/**
 * Runs all migrations up to the latest using the MigrationRunner.
 * Throws an error if any migration fails.
 */
export async function runMigrations(): Promise<void> {
  assertSafeTestEnvironment();
  const pool = getPool();
  const runner = new MigrationRunner(pool, repo, migrations);
  const result = await runner.up();
  
  if (!result.success) {
    throw new Error(`Migration Failed: ${result.failed} - ${result.error?.message}`);
  }
}

/**
 * Drops the public schema again. Can be used in afterAll() to clean up.
 */
export async function teardownDb(): Promise<void> {
  assertSafeTestEnvironment();
  const pool = getPool();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

/**
 * Checks if a specific table exists in the public schema.
 * @param tableName Name of the table to check
 * @returns boolean
 */
export async function verifyTableExists(tableName: string): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)",
    [tableName]
  );
  return res.rows[0].exists;
}

/**
 * Checks if a specific column exists in a given table.
 * @param tableName Name of the table
 * @param columnName Name of the column
 * @returns boolean
 */
export async function verifyColumnExists(tableName: string, columnName: string): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    "SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2)",
    [tableName, columnName]
  );
  return res.rows[0].exists;
}

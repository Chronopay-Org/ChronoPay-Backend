/**
 * migrate.ts — CLI entry point for the database migration framework.
 *
 * Usage:
 *   npm run migrate status
 *   npm run migrate validate
 *   npm run migrate up [count]
 *   npm run migrate down [count]     (default count = 1)
 *
 * Exit codes:
 *   0 — success
 *   1 — failure (invalid command, migration error, validation error)
 *
 * The pool is always closed in a finally block so the Node process exits
 * cleanly without waiting for idle connections to time out.
 */

import { getPool, closePool } from "../db/connection.js";
import * as repo from "../db/migrationRepository.js";
import { MigrationRunner } from "../db/migrationRunner.js";
import { migrations } from "../db/migrations/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error("\nUsage: migrate <command> [options]\n");
  console.error("Commands:");
  console.error("  status          Show which migrations have been applied");
  console.error("  validate        Validate migration definitions (no DB needed)");
  console.error("  up [count]      Apply pending migrations (all if count omitted)");
  console.error("  down [count]    Roll back migrations (default: 1)\n");
}

function parseCount(raw: string | undefined, defaultValue?: number): number | undefined {
  if (raw === undefined) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) {
    console.error(`  Error: count must be a positive integer, got: "${raw}"`);
    process.exit(1);
  }
  return n;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  const validCommands = ["up", "down", "status", "validate"];

  if (!command || !validCommands.includes(command)) {
    printUsage();
    process.exit(1);
  }

  // `validate` is a pure structural check — no database connection needed.
  if (command === "validate") {
    const runner = new MigrationRunner({} as ReturnType<typeof getPool>, repo, migrations);
    const result = await runner.validate();
    if (result.valid) {
      console.log(`\n  All ${migrations.length} migration(s) are valid.\n`);
    } else {
      console.error("\n  Validation failed:");
      for (const err of result.errors) {
        console.error(`    - ${err}`);
      }
      console.error("");
      process.exit(1);
    }
    return;
  }

  // All other commands require a database connection.
  const pool = getPool();
  const runner = new MigrationRunner(pool, repo, migrations);

  try {
    switch (command) {
      case "status": {
        const statuses = await runner.status();
        console.log("\n  Migration Status\n");
        for (const s of statuses) {
          const marker = s.status === "applied" ? "[+]" : "[ ]";
          const date = s.applied_at
            ? `  (applied ${s.applied_at.toISOString()})`
            : "";
          console.log(`    ${marker} ${s.id}  ${s.name}${date}`);
        }
        const pendingCount = statuses.filter((s) => s.status === "pending").length;
        const appliedCount = statuses.length - pendingCount;
        console.log(`\n  ${appliedCount} applied, ${pendingCount} pending\n`);
        break;
      }

      case "up": {
        const count = parseCount(args[0]);
        console.log("\n  Running up migrations...\n");
        const result = await runner.up(count);
        for (const id of result.applied) {
          const m = migrations.find((m) => m.id === id);
          console.log(`    [+] Applied: ${id}  ${m?.name ?? ""}`);
        }
        if (!result.success) {
          console.error(`\n    [!] Failed on migration: ${result.failed}`);
          console.error(`        ${result.error?.message}\n`);
          process.exit(1);
        }
        if (result.applied.length === 0) {
          console.log("    No pending migrations to apply.");
        }
        console.log(`\n  Done. ${result.applied.length} migration(s) applied.\n`);
        break;
      }

      case "down": {
        const count = parseCount(args[0], 1) as number;
        console.log(`\n  Rolling back ${count} migration(s)...\n`);
        const result = await runner.down(count);
        for (const id of result.applied) {
          const m = migrations.find((m) => m.id === id);
          console.log(`    [-] Rolled back: ${id}  ${m?.name ?? ""}`);
        }
        if (!result.success) {
          console.error(`\n    [!] Failed on rollback: ${result.failed}`);
          console.error(`        ${result.error?.message}\n`);
          process.exit(1);
        }
        if (result.applied.length === 0) {
          console.log("    No applied migrations to roll back.");
        }
        console.log(`\n  Done. ${result.applied.length} migration(s) rolled back.\n`);
        break;
      }
    }
  } finally {
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(
    "\n  Fatal error:",
    err instanceof Error ? err.message : String(err),
    "\n",
  );
  process.exit(1);
});

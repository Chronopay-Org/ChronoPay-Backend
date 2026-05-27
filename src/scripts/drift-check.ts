/**
 * drift-check.ts — CLI command for migration drift detection.
 *
 * Usage:
 *   npm run migrate drift-check
 *
 * Exit codes:
 *   0 — no drift detected
 *   1 — drift detected or validation failed
 *
 * Security: Does not log connection strings or credentials.
 */

import { getPool, closePool } from "../db/connection.js";
import * as repo from "../db/migrationRepository.js";
import { migrations } from "../db/migrations/index.js";
import { detectDrift, validateMigrationOrder } from "../db/driftDetector.js";

async function main(): Promise<void> {
  console.log("\n  Running migration drift check...\n");

  // Step 1: Validate migration definitions (no DB needed)
  console.log("  [1/3] Validating migration order and naming...");
  const orderResult = validateMigrationOrder(migrations);
  
  if (orderResult.errors.length > 0) {
    console.error("\n  ❌ Migration order validation failed:\n");
    for (const err of orderResult.errors) {
      console.error(`    - ${err}`);
    }
    console.error("");
    process.exit(1);
  }

  if (orderResult.warnings.length > 0) {
    console.log("\n  ⚠️  Warnings:\n");
    for (const warn of orderResult.warnings) {
      console.log(`    - ${warn}`);
    }
    console.log("");
  } else {
    console.log("  ✓ Migration order valid\n");
  }

  // Step 2: Check for drift against database
  const pool = getPool();
  
  try {
    console.log("  [2/3] Checking for schema drift...");
    
    // Ensure migrations table exists
    await repo.ensureMigrationsTable(pool);
    
    const applied = await repo.getAppliedMigrations(pool);
    const driftResult = detectDrift(migrations, applied);

    if (driftResult.hasDrift) {
      console.error("\n  ❌ Schema drift detected:\n");
      for (const err of driftResult.errors) {
        console.error(`    - ${err}`);
      }
      console.error("");
      process.exit(1);
    }

    if (driftResult.warnings.length > 0) {
      console.log("\n  ⚠️  Warnings:\n");
      for (const warn of driftResult.warnings) {
        console.log(`    - ${warn}`);
      }
      console.log("");
    } else {
      console.log("  ✓ No drift detected\n");
    }

    // Step 3: Summary
    console.log("  [3/3] Summary");
    console.log(`    Registered migrations: ${migrations.length}`);
    console.log(`    Applied migrations:    ${applied.length}`);
    console.log(`    Pending migrations:    ${migrations.length - applied.length}`);
    console.log("\n  ✅ All checks passed\n");

  } catch (err) {
    // Sanitize error to avoid leaking credentials
    const message = err instanceof Error ? err.message : String(err);
    const sanitized = message.replace(/password=[^\s&]+/gi, "password=***");
    console.error(`\n  ❌ Database connection failed: ${sanitized}\n`);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const sanitized = message.replace(/password=[^\s&]+/gi, "password=***");
  console.error(`\n  ❌ Fatal error: ${sanitized}\n`);
  process.exit(1);
});

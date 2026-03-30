/**
 * Migration registry — the single source of truth for migration ordering.
 *
 * Add new migrations here in chronological order. The array order defines
 * the execution sequence for `up` and the reverse sequence for `down`.
 *
 * A duplicate-ID guard runs at module load time so misconfiguration is caught
 * immediately (at startup or test import) rather than silently at runtime.
 */

import { Migration } from "../migrationRunner.js";
import { migration as migration001 } from "./001_create_users_table.js";
import { migration as migration002 } from "./002_create_slots_table.js";

export const migrations: Migration[] = [migration001, migration002];

// ─── Duplicate-ID guard ───────────────────────────────────────────────────────
// This runs once when the module is first imported. Fail-fast here is safer
// than discovering the error mid-migration run in production.
const ids = migrations.map((m) => m.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

if (duplicates.length > 0) {
  throw new Error(
    `Duplicate migration IDs detected: ${[...new Set(duplicates)].join(", ")}. ` +
      "Each migration must have a unique ID. " +
      "Fix the registry in src/db/migrations/index.ts before continuing.",
  );
}

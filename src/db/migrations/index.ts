// @ts-nocheck
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
import { migration as migration003 } from "./003_add_slot_conflict_exclusion.js";
import { migration as migration004 } from "./004_create_booking_intents_table.js";
import { migration as migration005 } from "./005_add_token_references_to_booking_intents.js";
import { migration as migration006 } from "./006_create_reminders_table.js";
import { migration as migration007a } from "./007_add_supplier_kyc_columns.js";
import { migration as migration007b } from "./007_create_checkout_sessions_table.js";
import { migration as migration008a } from "./008_add_marketplace_search_fields.js";
import { migration as migration008b } from "./008_create_recurrence_series.js";
import { migration as migration009 } from "./009_create_legal_holds.js";
import { migration as migration010 } from "./010_create_webhook_idempotency_keys.js";
import { migration as migration011a } from "./011_add_slot_valid_until.js";
import { migration as migration011b } from "./011_create_outbox_table.js";
import { migration as migration011c } from "./011_create_refund_entries_table.js";
import { migration as migration012 } from "./012_create_redemption_ledger.js";
import { migration as migration013 } from "./013_enable_row_level_security.js";
import { migration as migration014a } from "./014_add_reputation_bootstrap_columns.js";
import { migration as migration014b } from "./014_create_reputation_events.js";
import { migration as migration015 } from "./015_create_reputation_snapshots.js";
import { migration as migration016 } from "./016_add_grace_window_config.js";
import { migration as migration017 } from "./017_add_residency_waivers_table.js";

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007a,
  migration007b,
  migration008a,
  migration008b,
  migration009,
  migration010,
  migration011a,
  migration011b,
  migration011c,
  migration012,
  migration013,
  migration014a,
  migration014b,
  migration015,
  migration016,
  migration017,
];

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

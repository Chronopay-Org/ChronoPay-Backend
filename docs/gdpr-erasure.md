# GDPR Erasure Orchestrator

## Overview

The GDPR erasure orchestrator implements Article 17 of the GDPR ("right to erasure") for ChronoPay. It safely removes personal data across all PII-holding tables while preserving ledger integrity through the **null-with-hash tombstone pattern**.

## Architecture

```
POST /api/v1/gdpr/erase
        │
        ▼
GdprErasureOrchestrator
        │
        ├─ LegalHoldService.isHeld()      ← guard: block if subject is held
        │
        ├─ BEGIN TRANSACTION
        │
        ├─ getSortedGraph()               ← topological order (leaves first)
        │   └─ topoSort(PII_TABLE_GRAPH)
        │
        ├─ For each TableNode (in order):
        │   └─ tombstoneTable()           ← null PII + store SHA-256 hash
        │
        ├─ writeReceipt() → gdpr_erasure_events
        │
        ├─ COMMIT
        │
        └─ AuditLogger.log(completed)
```

## Null-with-Hash Tombstone Pattern

When a PII column is erased:

1. The original value is hashed with SHA-256 (hex).
2. The column is set to `NULL`.
3. If `storeHash: true` is configured for that column, a sibling `hash_<col>` column receives the hash.

Example — erasing `users.email`:

```sql
-- Before
SELECT email FROM users WHERE id = $1;
-- "alice@example.com"

-- After tombstone
SELECT email, hash_email FROM users WHERE id = $1;
-- NULL, "2e4d6a9f..."  (SHA-256 of "alice@example.com")
```

The hash allows compliance teams to prove (for a known value) that a specific record was erased, without reconstructing PII from the database. For columns where even the hash is a GDPR risk, set `storeHash: false`.

## FK Dependency Graph

The dependency graph defines the order in which tables are tombstoned. Dependent tables (leaf nodes) must be processed **before** their parent to avoid FK constraint violations.

```
booking_intents ─┐
                 ├──→  users  (last)
checkout_sessions─┘
```

The graph is defined in `src/services/gdprErasure/dependencyGraph.ts` as `PII_TABLE_GRAPH`. To add a new PII table:

```ts
export const PII_TABLE_GRAPH: TableNode[] = [
  // ... existing entries ...
  {
    table: "my_new_table",
    pkCol: "id",
    fkCol: "user_id",       // FK to users.id
    piiColumns: [
      { name: "phone_number", storeHash: true },
    ],
    dependsOn: [],          // list tables this must run AFTER
  },
];
```

### Circular dependency detection

`topoSort()` uses DFS with a grey/black colour scheme. If a cycle is detected a `CircularDependencyError` is thrown **before** any database mutation.

## Dry-Run Mode

Auditors (role: `auditor`) can preview an erasure without committing any changes:

```json
POST /api/v1/gdpr/erase
{ "subjectId": "...", "dryRun": true }
```

In dry-run mode:
- No `BEGIN` / `COMMIT` is issued.
- `SELECT` queries run to identify affected rows.
- `UPDATE` statements are **not** executed.
- A receipt with `dryRun: true` is still written to `gdpr_erasure_events`.
- The response includes a `plan` array describing what would be erased.

## API Reference

### `POST /api/v1/gdpr/erase`

**Authentication:** `x-chronopay-user-id` + `x-chronopay-role` headers required.

**Roles:**
- `admin` — can perform live erasures and dry-runs.
- `auditor` — dry-run only; live erasure returns `403`.

**Request body:**

```json
{
  "subjectId": "uuid-of-user-to-erase",
  "dryRun": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `subjectId` | string | yes | — | UUID of the data subject |
| `dryRun` | boolean | no | `false` | Preview mode |

**Success response (200):**

```json
{
  "success": true,
  "receipt": {
    "receiptId": "uuid",
    "subjectId": "uuid",
    "erasedAt": "2026-07-29T01:00:00Z",
    "tablesAffected": [
      { "table": "booking_intents", "rowsAffected": 3 },
      { "table": "users", "rowsAffected": 1 }
    ],
    "totalRowsAffected": 4,
    "dryRun": false,
    "requestedBy": "admin-uuid"
  }
}
```

**Dry-run response additionally includes:**

```json
{
  "plan": [
    {
      "table": "booking_intents",
      "plannedActions": [
        {
          "table": "booking_intents",
          "rowId": "row-uuid",
          "nulledColumns": ["note"],
          "hashedColumns": ["hash_note"]
        }
      ]
    }
  ]
}
```

**Error responses:**

| Status | Code | Reason |
|--------|------|--------|
| 400 | — | Missing/invalid `subjectId` |
| 401 | — | Missing auth headers |
| 403 | — | Insufficient role or auditor attempting live erasure |
| 409 | `LEGAL_HOLD` | Subject is under a legal hold |
| 500 | — | Unexpected server error |

## Event Log

Every erasure (live or dry-run) writes a receipt to `gdpr_erasure_events`:

```sql
SELECT * FROM gdpr_erasure_events WHERE subject_id = 'user-uuid' ORDER BY erased_at DESC;
```

The `receipt` JSONB column stores the complete `ErasureReceipt` payload.

## Legal Holds

Before any erasure, the orchestrator calls `LegalHoldService.isHeld(subjectId)`. If the subject has an active hold, the erasure is blocked with a `409 LEGAL_HOLD` response and an audit log entry is emitted.

To place a legal hold before erasing:

```ts
await LegalHoldService.addHold(subjectId, actorId, "regulatory investigation", "EEA");
```

## Transaction & Rollback Safety

Live erasures run inside a single PostgreSQL transaction. If any table's tombstone fails (network error, constraint violation, etc.), the transaction is rolled back — no partial erasure occurs. The `gdpr.erasure.failed` audit event is emitted with the error message.

## Database Migration

The `gdpr_erasure_events` table is created by migration `020_create_gdpr_erasure_events`:

```bash
npm run migrate up
```

## Adding Hash-Sibling Columns

The null-with-hash pattern requires `hash_<col>` columns to exist in the database. For existing tables you must run a migration to add them:

```sql
ALTER TABLE users     ADD COLUMN IF NOT EXISTS hash_email TEXT;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS hash_name  TEXT;
ALTER TABLE booking_intents ADD COLUMN IF NOT EXISTS hash_note TEXT;
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS hash_customer_email TEXT;
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS hash_customer_name  TEXT;
```

## Testing

```bash
npm test -- --testPathPattern="gdprErasure|dependencyGraph|tombstone|eventLog|GdprErasureOrchestrator"
```

Tests cover:
- Topological sort correctness
- Cycle detection (direct, indirect, self-reference)
- Unknown dependency detection
- Tombstone: null + hash, storeHash=false, multi-row, dry-run, null original values
- Orchestrator: legal hold guard, transaction commit/rollback, receipt writing, audit log emissions
- Route: auth enforcement, auditor dry-run restriction, request validation, 409 for legal hold

## Security Notes

- Table and column identifiers in SQL come from the internal `PII_TABLE_GRAPH` registry, never from user input.
- The `subjectId` is parameterised in all WHERE clauses.
- Only `admin` and `auditor` roles can reach the endpoint.
- Auditors are restricted to dry-run mode — they cannot commit mutations.
- Every erasure is audit-logged with actor ID and timestamp.
- The receipt hash allows post-hoc verification that a specific field was erased.

# Database Migrations

ChronoPay uses a custom migration framework with built-in drift detection and safety checks.

## Quick Start

```bash
# Check migration status
npm run migrate status

# Validate migrations (no DB needed)
npm run migrate validate

# Check for drift and naming issues
npm run migrate drift-check

# Apply pending migrations
npm run migrate up

# Roll back last migration
npm run migrate down
```

## Migration Safety

### Drift Detection

Drift occurs when the database schema diverges from the migration registry. This can happen when:

- Migrations are applied manually in one environment but not committed to git
- Migrations are applied out of order
- Migration files are deleted after being applied
- Migration names are changed after application

**Prevent drift:**

```bash
# Run before deploying to any environment
npm run migrate drift-check
```

This command checks for:

1. **Orphaned migrations**: Applied in database but missing from registry
2. **Name mismatches**: Migration ID exists but name differs
3. **Out-of-order application**: Migrations applied in wrong sequence
4. **Naming convention violations**: IDs not zero-padded numeric, names not snake_case

### CI Integration

Add to `.github/workflows/ci.yml`:

```yaml
- name: Check migration drift
  run: npm run migrate drift-check
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

This ensures:

- No drift before merging PRs
- Migrations follow naming conventions
- Sequential ordering is maintained

### Local Workflow

**Before creating a new migration:**

```bash
# 1. Pull latest changes
git pull origin main

# 2. Check current state
npm run migrate status

# 3. Check for drift
npm run migrate drift-check
```

**After creating a new migration:**

```bash
# 1. Validate structure
npm run migrate validate

# 2. Test locally
npm run migrate up

# 3. Verify no drift
npm run migrate drift-check

# 4. Commit migration file
git add src/db/migrations/
git commit -m "feat: add migration XXX_description"
```

## Migration Naming Convention

**Required format:**

- **ID**: Zero-padded numeric (001, 002, 003, ...)
- **Name**: snake_case (create_users_table, add_email_index)
- **Filename**: `{ID}_{name}.ts`

**Example:**

```
src/db/migrations/
├── 001_create_users_table.ts
├── 002_create_slots_table.ts
└── 003_add_booking_status.ts
```

**Why strict naming?**

- Ensures consistent ordering across environments
- Prevents accidental reordering in git
- Makes drift detection reliable
- Simplifies code review

## Creating a Migration

**1. Create the file:**

```bash
# Next ID is 003
touch src/db/migrations/003_add_booking_status.ts
```

**2. Implement up/down:**

```typescript
import { PoolClient } from "pg";
import { Migration } from "../migrationRunner.js";

export const migration: Migration = {
  id: "003",
  name: "add_booking_status",

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE bookings
      ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'pending'
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE bookings
      DROP COLUMN status
    `);
  },
};
```

**3. Register in index:**

```typescript
// src/db/migrations/index.ts
import { migration as migration003 } from "./003_add_booking_status.js";

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003, // Add here
];
```

**4. Test:**

```bash
npm run migrate validate
npm run migrate up
npm run migrate drift-check
```

## Edge Cases

### Missing Migration Table

**Scenario**: Database exists but `schema_migrations` table doesn't.

**Behavior**: `drift-check` creates the table automatically and reports zero applied migrations.

**Action**: Run `npm run migrate up` to apply all migrations.

### Partial Application

**Scenario**: Migration fails mid-execution.

**Behavior**: Transaction rolls back; migration is NOT recorded as applied.

**Action**: Fix the migration SQL and run `npm run migrate up` again.

### Orphaned Migration

**Scenario**: Migration applied in prod but file deleted from git.

**Detection**: `drift-check` reports:

```
Migration "005" (add_payment_table) is applied in database but missing from registry
```

**Resolution**:

1. Restore the migration file from git history
2. Re-add to registry
3. Run `drift-check` to confirm

### Out-of-Order Application

**Scenario**: Migration 003 applied before 002.

**Detection**: `drift-check` reports warning:

```
Migration "003" applied at position 1 but registered at position 2
```

**Resolution**: This is a warning, not an error. Document the reason or roll back and reapply in order.

## Security Notes

### Credential Protection

- Migration commands sanitize error messages to prevent credential leaks
- Connection strings are never logged
- Password parameters are redacted in error output

**Example sanitization:**

```
❌ Before: Connection failed: postgresql://user:secret123@localhost/db
✅ After:  Connection failed: postgresql://user:***@localhost/db
```

### Safe Failure Modes

- **Invalid config**: Process exits before connecting to database
- **Connection failure**: Error logged without credentials, exit code 1
- **Drift detected**: Reports issues without exposing schema details
- **Validation failure**: Lists problems without executing SQL

### Production Checklist

Before deploying migrations to production:

- [ ] Run `npm run migrate drift-check` in staging
- [ ] Verify all tests pass
- [ ] Review migration SQL for destructive operations
- [ ] Ensure rollback (down) is tested
- [ ] Check that no credentials are in migration files
- [ ] Confirm transaction boundaries are correct

## Commands Reference

| Command | Description | Requires DB |
|---------|-------------|-------------|
| `validate` | Check migration structure | No |
| `drift-check` | Detect schema drift | Yes |
| `status` | Show applied/pending | Yes |
| `up [count]` | Apply migrations | Yes |
| `down [count]` | Roll back migrations | Yes |

## Troubleshooting

### "Duplicate migration ID" error

**Cause**: Two migrations have the same ID.

**Fix**: Renumber migrations sequentially and update registry.

### "Migration has invalid ID format"

**Cause**: ID is not zero-padded numeric (e.g., "1" instead of "001").

**Fix**: Rename file and update ID to zero-padded format.

### "Schema drift detected"

**Cause**: Database state doesn't match registry.

**Fix**: See "Edge Cases" section above for specific scenarios.

### Connection timeout

**Cause**: Database not reachable or credentials incorrect.

**Fix**: Verify `DATABASE_URL` environment variable and network connectivity.

## Testing Migrations

Migrations are tested in `src/__tests__/db/`:

- `migrationRunner.test.ts` - Core runner logic
- `migrationRepository.test.ts` - Database operations
- `driftDetector.test.ts` - Drift detection logic

Run tests:

```bash
npm test -- db
```

## Further Reading

- [Migration Runner Source](../src/db/migrationRunner.ts)
- [Drift Detector Source](../src/db/driftDetector.ts)
- [Migration Repository Source](../src/db/migrationRepository.ts)

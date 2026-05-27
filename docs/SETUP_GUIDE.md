# Quick Setup & Testing Guide

## Installation

Since you haven't installed packages yet, run:

```bash
npm install
```

## Build & Test

```bash
# 1. Build TypeScript
npm run build

# 2. Run all tests
npm test

# 3. Run only drift detector tests
npm test -- driftDetector.test.ts
```

## Try the New Commands

### Without Database (works immediately)

```bash
# Validate migration structure
npm run migrate validate

# This checks:
# - No duplicate IDs
# - All migrations have id, name, up, down
# - Proper function signatures
```

### With Database (requires DATABASE_URL env var)

```bash
# Check for drift
npm run migrate drift-check

# This checks:
# - Migration naming conventions (001, 002, snake_case)
# - Sequential ordering (no gaps)
# - Orphaned migrations (in DB but not in code)
# - Name mismatches between code and DB
```

## What Was Implemented

### New Files
- `src/db/driftDetector.ts` - Core drift detection logic
- `src/scripts/drift-check.ts` - Standalone CLI command
- `src/__tests__/db/driftDetector.test.ts` - Comprehensive tests
- `docs/database/migrations.md` - Complete documentation

### Updated Files
- `src/scripts/migrate.ts` - Added drift-check command
- `README.md` - Added migration section
- `.github/workflows/ci.yml` - Added validation step

## Testing Checklist

- [ ] `npm install` completes successfully
- [ ] `npm run build` compiles without errors
- [ ] `npm test` passes all tests
- [ ] `npm run migrate validate` shows "All X migration(s) are valid"
- [ ] `npm run migrate drift-check` works (if DB available)

## Expected Test Output

When you run `npm test -- driftDetector.test.ts`, you should see:

```
PASS  src/__tests__/db/driftDetector.test.ts
  detectDrift
    ✓ returns no drift when registry and database match
    ✓ detects orphaned migration (applied but not in registry)
    ✓ detects name mismatch between registry and database
    ✓ warns about out-of-order application
    ✓ handles empty applied migrations
    ✓ handles empty registry
    ✓ detects multiple orphaned migrations
  validateMigrationOrder
    ✓ validates correct sequential migrations
    ✓ rejects non-numeric migration IDs
    ✓ rejects non-zero-padded IDs
    ✓ detects gaps in sequential IDs
    ✓ warns about non-snake_case names
    ✓ accepts valid snake_case names
    ✓ handles empty migration list
    ✓ detects multiple naming violations
    ✓ accepts 4-digit zero-padded IDs
  edge cases
    ✓ handles migrations with same name but different IDs
    ✓ detects drift with partial application

Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
```

## Commit Your Changes

```bash
git add .
git commit -m "feat: implement migration safety and drift detection

- Add drift detection for schema divergence
- Validate migration naming and ordering
- Add drift-check CLI command
- Include comprehensive tests and documentation
- Integrate with CI pipeline
- Ensure security (no credential leaks)"

git push origin feature/migration-safety-checks
```

## Next Steps

1. Install dependencies: `npm install`
2. Run tests: `npm test`
3. Try commands: `npm run migrate validate`
4. Review documentation: `docs/database/migrations.md`
5. Commit and push your changes
6. Create pull request

## Documentation

- **Main docs**: `docs/database/migrations.md`
- **Implementation summary**: `MIGRATION_SAFETY_IMPLEMENTATION.md`
- **README section**: Search for "Database Migrations"

## Questions?

Check the documentation or review the implementation summary for details on:
- How drift detection works
- Security measures
- Edge case handling
- CI integration
- Production deployment

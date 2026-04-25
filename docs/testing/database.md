# Database Test Harness

The Database Test Harness provides utilities to run migration and integration tests against a real PostgreSQL database cleanly and safely.

## Safety First ⚠️

The DB Test Harness is designed to be **destructive**—it will drop and recreate the `public` schema.

To prevent accidental data loss in production, the harness enforces the following strict checks before executing any destructive operations:
1. `NODE_ENV` must exactly equal `"test"`.
2. The `DATABASE_URL` environment variable must be set.
3. The `DATABASE_URL` must contain the string `"test"` (e.g., `postgres://user:pass@localhost:5432/chronopay_test`).

If these conditions are not met, the harness will throw a **Security Error** and abort.

## Utilities

Import the utilities from `src/__tests__/utils/dbTestHarness.ts`:

```typescript
import {
  setupCleanDb,
  runMigrations,
  teardownDb,
  verifyTableExists,
  verifyColumnExists
} from "../utils/dbTestHarness.js";
```

### `setupCleanDb()`
Drops the `public` schema and recreates it. Ideal for `beforeEach` or `beforeAll` blocks.

### `runMigrations()`
Instantiates the `MigrationRunner` and applies all pending migrations defined in `src/db/migrations/index.ts`. If any migration fails, it throws a clear diagnostic error.

### `verifyTableExists(tableName)`
Queries `information_schema.tables` and returns a boolean indicating if the table exists in the `public` schema.

### `verifyColumnExists(tableName, columnName)`
Queries `information_schema.columns` and returns a boolean indicating if the specified column exists in the given table.

### `teardownDb()`
Drops and recreates the `public` schema to clean up after tests. Useful in `afterAll` blocks.

## Example Jest Suite

```typescript
import { setupCleanDb, runMigrations, teardownDb, verifyTableExists } from "../utils/dbTestHarness.js";
import { getPool, closePool } from "../../db/connection.js";

describe("Database Migrations", () => {
  beforeAll(async () => {
    // Ensure environment is set correctly for testing
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/chronopay_test";
  });

  afterAll(async () => {
    await teardownDb();
    await closePool();
  });

  it("should create a clean DB and run migrations", async () => {
    await setupCleanDb();
    
    // DB should be empty
    expect(await verifyTableExists("users")).toBe(false);

    // Run all migrations
    await runMigrations();

    // Tables should now exist
    expect(await verifyTableExists("users")).toBe(true);
    expect(await verifyTableExists("slots")).toBe(true);
  });
});
```

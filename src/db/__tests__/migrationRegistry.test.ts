import type { Pool } from "pg";

import { migrations } from "../migrations/index.js";
import { validateMigrationOrder } from "../driftDetector.js";
import { MigrationRunner } from "../migrationRunner.js";

// `validate` and `validateMigrationOrder` are pure structural checks: the pool is
// never touched, so a stub repository is enough to exercise the real registry.
const noopRepo = {
  ensureMigrationsTable: async () => {},
  getAppliedMigrations: async () => [],
  recordMigration: async () => {},
  removeMigration: async () => {},
};

describe("migration registry", () => {
  it("registers unique, zero-padded, strictly sequential IDs", () => {
    const ids = migrations.map((m) => m.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.map((_, index) => String(index + 1).padStart(3, "0")));
  });

  it("passes the `npm run migrate validate` guard used by CI", async () => {
    const runner = new MigrationRunner(null as unknown as Pool, noopRepo, migrations);

    await expect(runner.validate()).resolves.toEqual({ valid: true, errors: [] });
  });

  it("passes the drift-check order validation", () => {
    expect(validateMigrationOrder(migrations).errors).toEqual([]);
  });
});

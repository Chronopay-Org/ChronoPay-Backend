/**
 * Regression coverage for the migration registry (src/db/migrations/index.ts).
 *
 * Exercises the module-load duplicate-ID guard (the `throw` path), the normal
 * registry, and the boundary inputs around it. The guard is exported so the
 * failure branch can be asserted directly instead of importing a broken registry.
 */

import {
  migrations,
  findDuplicateMigrationIds,
  assertUniqueMigrationIds,
} from "../index.js";
import type { Migration } from "../../migrationRunner.js";

function fakeMigration(id: string): Migration {
  return {
    id,
    name: `fake_${id}`,
    up: jest.fn(async () => undefined),
    down: jest.fn(async () => undefined),
  } as unknown as Migration;
}

describe("migrations registry", () => {
  it("registers a non-empty, well-formed ordered list", () => {
    expect(Array.isArray(migrations)).toBe(true);
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(typeof migration.id).toBe("string");
      expect(migration.id.length).toBeGreaterThan(0);
    }
  });

  it("has unique IDs, so the module-load guard accepts the real registry", () => {
    expect(findDuplicateMigrationIds(migrations)).toEqual([]);
    expect(() => assertUniqueMigrationIds(migrations)).not.toThrow();
  });

  it("throws a descriptive error when duplicate IDs are present", () => {
    const registry = [
      fakeMigration("001_duplicate"),
      fakeMigration("002_unique"),
      fakeMigration("001_duplicate"),
    ];

    expect(findDuplicateMigrationIds(registry)).toEqual(["001_duplicate"]);
    expect(() => assertUniqueMigrationIds(registry)).toThrow(
      /Duplicate migration IDs detected: 001_duplicate\. Each migration must have a unique ID\./,
    );
  });

  it("reports every duplicated ID, not just the first", () => {
    const registry = [
      fakeMigration("a"),
      fakeMigration("a"),
      fakeMigration("b"),
      fakeMigration("b"),
      fakeMigration("c"),
    ];

    expect(findDuplicateMigrationIds(registry)).toEqual(["a", "b"]);
    expect(() => assertUniqueMigrationIds(registry)).toThrow(/a, b/);
  });

  it("accepts boundary registries (empty and single entry)", () => {
    expect(findDuplicateMigrationIds([])).toEqual([]);
    expect(() => assertUniqueMigrationIds([])).not.toThrow();

    const single = [fakeMigration("only")];
    expect(findDuplicateMigrationIds(single)).toEqual([]);
    expect(() => assertUniqueMigrationIds(single)).not.toThrow();
  });
});

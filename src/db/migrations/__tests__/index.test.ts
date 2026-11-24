/**
 * Regression coverage for the migration registry (src/db/migrations/index.ts).
 *
 * Exercises the module-load duplicate-ID guard (the `throw` path), the normal
 * registry, and the boundary inputs around it. The guard is exported so the
 * failure branch can be asserted directly instead of importing a broken registry.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("registers every migration source file exactly once", () => {
    const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
    const migrationFiles = readdirSync(migrationsDirectory).filter(
      (file) => file.endsWith(".ts") && file !== "index.ts" && !file.endsWith(".test.ts"),
    );
    const registrySource = readFileSync(join(migrationsDirectory, "index.ts"), "utf8");
    const importAliases = new Map<string, string>();
    const importCounts = new Map<string, number>();
    const aliasImportCounts = new Map<string, number>();
    const importPattern =
      /^import\s+\{\s*migration\s+as\s+(\w+)\s*\}\s+from\s+"\.\/([^"]+)\.js";$/gm;

    for (const match of registrySource.matchAll(importPattern)) {
      const [, alias, file] = match;
      const migrationFile = `${file}.ts`;
      importAliases.set(migrationFile, alias);
      importCounts.set(migrationFile, (importCounts.get(migrationFile) ?? 0) + 1);
      aliasImportCounts.set(alias, (aliasImportCounts.get(alias) ?? 0) + 1);
    }

    const registryArray = registrySource.match(
      /export const migrations: Migration\[\] = \[([\s\S]*?)\];/,
    )?.[1];
    expect(registryArray).toBeDefined();

    const registeredAliases = registryArray?.match(/^\s*(migration\w+),?\s*$/gm) ?? [];
    const registeredAliasCounts = new Map<string, number>();
    for (const line of registeredAliases) {
      const alias = line.trim().replace(/,$/, "");
      registeredAliasCounts.set(alias, (registeredAliasCounts.get(alias) ?? 0) + 1);
    }

    const unregisteredFiles = migrationFiles.filter(
      (file) => importCounts.get(file) !== 1 || registeredAliasCounts.get(importAliases.get(file)!) !== 1,
    );
    const unexpectedImports = [...importAliases.keys()].filter((file) => !migrationFiles.includes(file));
    const importedAliases = new Set(importAliases.values());
    const unexpectedRegistrations = [...registeredAliasCounts.keys()].filter((alias) => !importedAliases.has(alias));
    const incorrectlyRegisteredAliases = [...importedAliases].filter(
      (alias) => aliasImportCounts.get(alias) !== 1 || registeredAliasCounts.get(alias) !== 1,
    );

    expect(unregisteredFiles).toEqual([]);
    expect(unexpectedImports).toEqual([]);
    expect(unexpectedRegistrations).toEqual([]);
    expect(incorrectlyRegisteredAliases).toEqual([]);
  });

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

import { detectDrift, validateMigrationOrder } from "../driftDetector.js";
import type { Migration } from "../migrationRunner.js";
import type { AppliedMigration } from "../migrationRepository.js";

/**
 * Boundary and state-transition coverage for driftDetector.ts (issue #1028).
 *
 * The sibling driftDetector.test.ts covers the headline drift cases. This suite
 * closes the gaps it leaves uncovered, specifically:
 *
 *  - the "no drift at all" baseline (registry and database fully in sync),
 *  - empty and never-applied inputs, and
 *  - the invalid-ID-format error branch in validateMigrationOrder
 *    (/^\d{3,}$/), which no existing test exercises.
 */

const migration = (id: string, name: string): Migration => ({
  id,
  name,
  up: async () => {},
  down: async () => {},
});

const applied = (id: string, name: string): AppliedMigration => ({
  id,
  name,
  applied_at: new Date("2026-01-01T00:00:00.000Z"),
});

describe("driftDetector boundaries", () => {
  describe("detectDrift - no-drift baseline", () => {
    it("reports no drift when the database matches the registry exactly", () => {
      const registered = [migration("001", "initial_schema"), migration("002", "add_users")];
      const appliedMigrations = [applied("001", "initial_schema"), applied("002", "add_users")];

      expect(detectDrift(registered, appliedMigrations)).toEqual({
        hasDrift: false,
        errors: [],
        warnings: [],
      });
    });

    it("reports no drift for empty inputs", () => {
      expect(detectDrift([], [])).toEqual({ hasDrift: false, errors: [], warnings: [] });
    });

    it("reports no drift when nothing has been applied yet", () => {
      expect(detectDrift([migration("001", "initial_schema")], [])).toEqual({
        hasDrift: false,
        errors: [],
        warnings: [],
      });
    });
  });

  describe("detectDrift - combined failures and warnings", () => {
    it("reports orphaned, mismatched and out-of-order migrations together", () => {
      const registered = [migration("001", "initial_schema"), migration("002", "add_users")];
      const appliedMigrations = [
        applied("002", "add_user_table"),
        applied("001", "initial_schema"),
        applied("099", "legacy_import"),
      ];

      const result = detectDrift(registered, appliedMigrations);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain(
        'Migration "002" name mismatch: registry="add_users", database="add_user_table"',
      );
      expect(result.errors).toContain(
        'Migration "099" (legacy_import) is applied in database but missing from registry',
      );
      expect(result.warnings).toEqual([
        'Migration "002" applied at position 0 but registered at position 1',
        'Migration "001" applied at position 1 but registered at position 0',
      ]);
    });

    it("keeps hasDrift false when only ordering warnings are raised", () => {
      const registered = [migration("001", "initial_schema"), migration("002", "add_users")];
      const appliedMigrations = [applied("002", "add_users"), applied("001", "initial_schema")];

      const result = detectDrift(registered, appliedMigrations);

      expect(result.hasDrift).toBe(false);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(2);
    });
  });

  describe("validateMigrationOrder - invalid ID format", () => {
    it("flags an id that is not numeric", () => {
      const result = validateMigrationOrder([migration("abc", "initial_schema")]);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toContain(
        'Migration "abc" has invalid ID format. Expected zero-padded numeric (e.g., "001", "002")',
      );
    });

    it("flags a numeric id that is shorter than three digits", () => {
      const result = validateMigrationOrder([migration("12", "initial_schema")]);

      expect(result.errors).toContain(
        'Migration "12" has invalid ID format. Expected zero-padded numeric (e.g., "001", "002")',
      );
    });

    it("does not flag a zero-padded id of four or more digits", () => {
      const result = validateMigrationOrder([migration("0001", "initial_schema")]);

      expect(result.errors.some((e) => e.includes("invalid ID format"))).toBe(false);
    });
  });

  describe("validateMigrationOrder - clean and empty baselines", () => {
    it("reports no drift for an empty migration list", () => {
      expect(validateMigrationOrder([])).toEqual({ hasDrift: false, errors: [], warnings: [] });
    });

    it("reports no drift when every id and name is valid and sequential", () => {
      const result = validateMigrationOrder([
        migration("001", "initial_schema"),
        migration("002", "add_users"),
        migration("003", "add_orders"),
      ]);

      expect(result).toEqual({ hasDrift: false, errors: [], warnings: [] });
    });
  });
});

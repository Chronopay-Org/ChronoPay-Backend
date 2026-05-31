import { detectDrift, validateMigrationOrder } from "../driftDetector.js";

type TestMigration = {
  id: string;
  name: string;
};

describe("driftDetector", () => {
  describe("detectDrift", () => {
    it("reports a renamed migration when database name differs from registry", () => {
      const registered: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "002", name: "add_users" },
      ];
      const applied: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "002", name: "add_user_table" },
      ];

      // @ts-expect-error - Auto-fixed by script
      const result = detectDrift(registered, applied as any);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toContain(
        'Migration "002" name mismatch: registry="add_users", database="add_user_table"'
      );
      expect(result.warnings).toHaveLength(0);
    });

    it("flags applied migrations that are missing from the registry", () => {
      const registered: TestMigration[] = [{ id: "001", name: "initial_schema" }];
      const applied = [{ id: "001", name: "initial_schema" }, { id: "002", name: "stray_migration" }];

      // @ts-expect-error - Auto-fixed by script
      const result = detectDrift(registered, applied as any);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toContain(
        'Migration "002" (stray_migration) is applied in database but missing from registry'
      );
    });

    it("warns when applied migration order differs from registry order", () => {
      const registered: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "002", name: "add_users" },
        { id: "003", name: "add_orders" },
      ];
      const applied: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "003", name: "add_orders" },
        { id: "002", name: "add_users" },
      ];

      // @ts-expect-error - Auto-fixed by script
      const result = detectDrift(registered, applied as any);

      expect(result.hasDrift).toBe(false);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          'Migration "003" applied at position 1 but registered at position 2',
          'Migration "002" applied at position 2 but registered at position 1',
        ])
      );
    });
  });

  describe("validateMigrationOrder", () => {
    it("detects gaps in migration numbering without touching the database", () => {
      const migrations: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "003", name: "add_users" },
      ];

      const result = validateMigrationOrder(migrations as any);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toContain(
        'Migration at position 1 has ID "003" but expected "002". Migrations must be sequential.'
      );
    });

    it("flags duplicate migration ids", () => {
      const migrations: TestMigration[] = [
        { id: "001", name: "initial_schema" },
        { id: "001", name: "duplicate" },
      ];

      const result = validateMigrationOrder(migrations as any);

      expect(result.hasDrift).toBe(true);
      expect(result.errors).toContain('Duplicate migration ID "001" appears 2 times');
    });

    it("warns on non-snake-case migration names", () => {
      const migrations: TestMigration[] = [
        { id: "001", name: "InitialSchema" },
      ];

      const result = validateMigrationOrder(migrations as any);

      expect(result.hasDrift).toBe(false);
      expect(result.warnings).toContain(
        'Migration "001" name "InitialSchema" should use snake_case convention'
      );
    });
  });
});

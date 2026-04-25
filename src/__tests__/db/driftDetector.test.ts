/**
 * driftDetector.test.ts
 *
 * Tests for migration drift detection and validation.
 */

import { describe, it, expect } from "@jest/globals";
import { detectDrift, validateMigrationOrder } from "../../db/driftDetector.js";
import type { Migration } from "../../db/migrationRunner.js";
import type { AppliedMigration } from "../../db/migrationRepository.js";

describe("detectDrift", () => {
  it("returns no drift when registry and database match", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
      { id: "002", name: "create_slots", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
      { id: "002", name: "create_slots", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("detects orphaned migration (applied but not in registry)", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
      { id: "002", name: "create_slots", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("002");
    expect(result.errors[0]).toContain("missing from registry");
  });

  it("detects name mismatch between registry and database", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users_table", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("name mismatch");
    expect(result.errors[0]).toContain("create_users_table");
    expect(result.errors[0]).toContain("create_users");
  });

  it("warns about out-of-order application", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
      { id: "002", name: "create_slots", up: async () => {}, down: async () => {} },
      { id: "003", name: "create_bookings", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
      { id: "003", name: "create_bookings", applied_at: new Date() },
      { id: "002", name: "create_slots", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(false); // Out-of-order is warning, not error
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("003"))).toBe(true);
  });

  it("handles empty applied migrations", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("handles empty registry", () => {
    const registered: Migration[] = [];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing from registry");
  });

  it("detects multiple orphaned migrations", () => {
    const registered: Migration[] = [];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
      { id: "002", name: "create_slots", applied_at: new Date() },
      { id: "003", name: "create_bookings", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(3);
  });
});

describe("validateMigrationOrder", () => {
  it("validates correct sequential migrations", () => {
    const migrations: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
      { id: "002", name: "create_slots", up: async () => {}, down: async () => {} },
      { id: "003", name: "add_booking_status", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("rejects non-numeric migration IDs", () => {
    const migrations: Migration[] = [
      { id: "abc", name: "create_users", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid ID format");
  });

  it("rejects non-zero-padded IDs", () => {
    const migrations: Migration[] = [
      { id: "1", name: "create_users", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(2); // Invalid format + wrong expected ID
    expect(result.errors[0]).toContain("invalid ID format");
  });

  it("detects gaps in sequential IDs", () => {
    const migrations: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
      { id: "003", name: "create_slots", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("expected \"002\"");
  });

  it("warns about non-snake_case names", () => {
    const migrations: Migration[] = [
      { id: "001", name: "CreateUsers", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("snake_case");
  });

  it("accepts valid snake_case names", () => {
    const migrations: Migration[] = [
      { id: "001", name: "create_users_table", up: async () => {}, down: async () => {} },
      { id: "002", name: "add_email_index", up: async () => {}, down: async () => {} },
      { id: "003", name: "alter_slots_add_status", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.warnings).toEqual([]);
  });

  it("handles empty migration list", () => {
    const migrations: Migration[] = [];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("detects multiple naming violations", () => {
    const migrations: Migration[] = [
      { id: "001", name: "CreateUsers", up: async () => {}, down: async () => {} },
      { id: "002", name: "Add-Slots", up: async () => {}, down: async () => {} },
      { id: "003", name: "Update Bookings", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts 4-digit zero-padded IDs", () => {
    const migrations: Migration[] = [
      { id: "0001", name: "create_users", up: async () => {}, down: async () => {} },
    ];

    const result = validateMigrationOrder(migrations);

    expect(result.hasDrift).toBe(true); // Wrong expected ID (should be 001)
    expect(result.errors[0]).toContain("expected \"001\"");
  });
});

describe("edge cases", () => {
  it("handles migrations with same name but different IDs", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_table", up: async () => {}, down: async () => {} },
      { id: "002", name: "create_table", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_table", applied_at: new Date() },
      { id: "002", name: "create_table", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(false); // Same names are OK if IDs match
  });

  it("detects drift with partial application", () => {
    const registered: Migration[] = [
      { id: "001", name: "create_users", up: async () => {}, down: async () => {} },
      { id: "002", name: "create_slots", up: async () => {}, down: async () => {} },
    ];

    const applied: AppliedMigration[] = [
      { id: "001", name: "create_users", applied_at: new Date() },
    ];

    const result = detectDrift(registered, applied);

    expect(result.hasDrift).toBe(false); // Pending migrations are not drift
    expect(result.errors).toEqual([]);
  });
});

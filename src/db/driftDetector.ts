/**
 * driftDetector.ts
 *
 * Detects schema drift between registered migrations and applied migrations.
 * Prevents silent divergence across environments (dev, staging, prod).
 */

import type { Migration } from "./migrationRunner.js";
import type { AppliedMigration } from "./migrationRepository.js";

export interface DriftResult {
  hasDrift: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Detects drift between registered migrations and applied migrations.
 * 
 * Checks for:
 * - Applied migrations not in registry (orphaned)
 * - Name mismatches between registry and applied
 * - Out-of-order application
 */
export function detectDrift(
  registered: Migration[],
  applied: AppliedMigration[]
): DriftResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const registeredMap = new Map(registered.map((m) => [m.id, m]));
  const appliedMap = new Map(applied.map((m) => [m.id, m]));

  // Check for orphaned migrations (applied but not in registry)
  for (const appliedMig of applied) {
    const registered = registeredMap.get(appliedMig.id);
    if (!registered) {
      errors.push(
        `Migration "${appliedMig.id}" (${appliedMig.name}) is applied in database but missing from registry`
      );
    } else if (registered.name !== appliedMig.name) {
      errors.push(
        `Migration "${appliedMig.id}" name mismatch: registry="${registered.name}", database="${appliedMig.name}"`
      );
    }
  }

  // Check for out-of-order application
  const appliedIds = applied.map((m) => m.id);
  const registeredIds = registered.map((m) => m.id);
  
  for (let i = 0; i < appliedIds.length; i++) {
    const appliedId = appliedIds[i];
    const registryIndex = registeredIds.indexOf(appliedId);
    
    if (registryIndex !== -1 && registryIndex !== i) {
      warnings.push(
        `Migration "${appliedId}" applied at position ${i} but registered at position ${registryIndex}`
      );
    }
  }

  return {
    hasDrift: errors.length > 0,
    errors,
    warnings,
  };
}

/**
 * Validates migration naming convention and ordering.
 * 
 * Enforces:
 * - IDs are numeric and zero-padded (001, 002, ...)
 * - IDs are sequential without gaps
 * - Names follow snake_case convention
 */
export function validateMigrationOrder(migrations: Migration[]): DriftResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];
    
    // Validate ID format (numeric, zero-padded)
    if (!/^\d{3,}$/.test(m.id)) {
      errors.push(
        `Migration "${m.id}" has invalid ID format. Expected zero-padded numeric (e.g., "001", "002")`
      );
    }

    // Validate name format (snake_case)
    if (!/^[a-z][a-z0-9_]*$/.test(m.name)) {
      warnings.push(
        `Migration "${m.id}" name "${m.name}" should use snake_case convention`
      );
    }

    // Check sequential ordering
    const expectedId = String(i + 1).padStart(3, "0");
    if (m.id !== expectedId) {
      errors.push(
        `Migration at position ${i} has ID "${m.id}" but expected "${expectedId}". Migrations must be sequential.`
      );
    }
  }

  return {
    hasDrift: errors.length > 0,
    errors,
    warnings,
  };
}

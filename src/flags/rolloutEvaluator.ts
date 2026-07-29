/**
 * rolloutEvaluator.ts
 * --------------------
 * Bridges the boolean feature-flag system (service.ts) with scheduled
 * percentage rollouts (rolloutScheduleRegistry.ts).
 *
 * Layering: the boolean flag is always the outer kill-switch. A rollout
 * schedule only narrows an *enabled* flag down to a percentage of traffic;
 * it can never turn on a flag that is disabled at the boolean level. This
 * keeps the existing `isFeatureEnabled` semantics backward compatible and
 * gives operators a single fail-closed switch that overrides every ramp.
 */

import { isFeatureEnabled } from "./service.js";
import { ALL_TENANTS } from "./rolloutTypes.js";
import { getRolloutScheduleRegistry, type RolloutScheduleRegistry } from "./rolloutScheduleRegistry.js";
import { ROLLOUT_ENVIRONMENTS, type FeatureFlagName, type RolloutEnvironment } from "./types.js";

/** Reads the current deployment environment, falling back to "development". */
export function currentRolloutEnvironment(): RolloutEnvironment {
  const raw = process.env.NODE_ENV;
  return (ROLLOUT_ENVIRONMENTS as readonly string[]).includes(raw ?? "")
    ? (raw as RolloutEnvironment)
    : "development";
}

/**
 * Deterministic string -> [0, 100) bucket using FNV-1a. Stable across
 * processes and restarts so the same bucket key always lands in the same
 * bucket, which is what makes percentage rollouts sticky per-tenant/user
 * instead of flapping on every request.
 */
export function hashToBucket(input: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return (hash >>> 0) % 100;
}

export function isBucketedIn(bucketKey: string, percentage: number): boolean {
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  return hashToBucket(bucketKey) < percentage;
}

/**
 * Current rollout percentage for (flag, tenantId, environment). Returns 100
 * (unrestricted) when no schedule governs this tuple, so a flag with no
 * rollout schedule behaves exactly like the plain boolean flag it always was.
 */
export function getRolloutPercentage(
  flag: FeatureFlagName,
  tenantId: string,
  environment: RolloutEnvironment = currentRolloutEnvironment(),
  registry: RolloutScheduleRegistry = getRolloutScheduleRegistry(),
): number {
  const schedule = registry.findGoverningSchedule(flag, tenantId, environment);
  return schedule ? schedule.currentPercentage : 100;
}

/**
 * Full evaluation: the boolean flag must be enabled AND the bucket key must
 * fall within the currently-active rollout percentage (if any schedule
 * governs this tuple, tenant-specific schedules taking priority over an
 * `ALL_TENANTS` wildcard).
 */
export function isFeatureEnabledForTenant(
  flag: FeatureFlagName,
  tenantId: string,
  bucketKey: string,
  environment: RolloutEnvironment = currentRolloutEnvironment(),
): boolean {
  if (!isFeatureEnabled(flag)) return false;
  const percentage = getRolloutPercentage(flag, tenantId, environment);
  return isBucketedIn(bucketKey, percentage);
}

export { ALL_TENANTS };

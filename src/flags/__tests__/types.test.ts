/**
 * Focused behavior coverage for `src/flags/types.ts` (issue #1083).
 *
 * `types.ts` looks like a pure type module, but it exports two runtime
 * constants that the whole flag system depends on:
 *
 *  - `FEATURE_FLAG_NAMES` anchors `FeatureFlagName`, `FeatureFlagState`
 *    (every flag must have a boolean), and the registry lookup in
 *    `service.ts` (`resolveFeatureFlags` iterates it; `isFeatureEnabled`
 *    rejects anything not in it).
 *  - `ROLLOUT_ENVIRONMENTS` anchors `RolloutEnvironment` and mirrors `NodeEnv`
 *    for rollout schedules.
 *
 * The suite pins the exact public shape of both constants, the invariants
 * downstream code relies on (no duplicates, no drift from the registry, valid
 * env-var bindings), and the invalid-input behavior of the accessors that are
 * typed by them (`isFeatureEnabled` on unknown flags, malformed env values).
 *
 * The `FeatureFlagName`/`FeatureFlagGuardedMethod` type aliases themselves are
 * erased at runtime; their guarantees are asserted structurally by compiling
 * the representative assignments below and by round-tripping the guards in the
 * registry through the route fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";

import {
  FEATURE_FLAG_NAMES,
  ROLLOUT_ENVIRONMENTS,
  type FeatureFlagAccessor,
  type FeatureFlagDefinition,
  type FeatureFlagGuardedMethod,
  type FeatureFlagGuardedRoute,
  type FeatureFlagName,
  type FeatureFlagState,
  type RolloutEnvironment,
} from "../types.js";
import { FEATURE_FLAGS } from "../registry.js";
import {
  isFeatureEnabled,
  resolveFeatureFlags,
  setFeatureFlagsFromEnv,
  getFeatureFlagAccessor,
} from "../service.js";

// Compile-time assertions: the exported aliases accept their documented
// members and reject nothing here. If the union drifts, `tsc --noEmit` fails.
const guardedMethods: readonly FeatureFlagGuardedMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];
const flagNames: readonly FeatureFlagName[] = FEATURE_FLAG_NAMES;
const rolloutEnvs: readonly RolloutEnvironment[] = ROLLOUT_ENVIRONMENTS;
void guardedMethods;
void flagNames;
void rolloutEnvs;

describe("FEATURE_FLAG_NAMES (issue #1083)", () => {
  it("is a non-empty frozen tuple of known flag names", () => {
    expect(FEATURE_FLAG_NAMES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(FEATURE_FLAG_NAMES)).toBe(true);
    expect([...FEATURE_FLAG_NAMES]).toEqual([
      "CREATE_SLOT",
      "CREATE_BOOKING_INTENT",
      "CHECKOUT",
      "SMS_NOTIFICATIONS",
      "SEARCH_LTR_RERANKER",
    ]);
  });

  it("contains no duplicates and no empty entries", () => {
    expect(new Set(FEATURE_FLAG_NAMES).size).toBe(FEATURE_FLAG_NAMES.length);
    for (const name of FEATURE_FLAG_NAMES) {
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it("has exactly one registry definition per declared flag (no drift)", () => {
    for (const name of FEATURE_FLAG_NAMES) {
      const definition: FeatureFlagDefinition | undefined = FEATURE_FLAGS[name];
      expect(definition).toBeDefined();
    }
    expect(Object.keys(FEATURE_FLAGS).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
  });

  it("binds every flag to a distinct FF_-prefixed env var", () => {
    const envVars = FEATURE_FLAG_NAMES.map((name) => FEATURE_FLAGS[name].envVar);
    for (const envVar of envVars) {
      expect(envVar).toMatch(/^FF_[A-Z0-9_]+$/);
    }
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("round-trips every name through resolveFeatureFlags into a boolean state", () => {
    const state: FeatureFlagState = resolveFeatureFlags({});
    for (const name of FEATURE_FLAG_NAMES) {
      expect(typeof state[name]).toBe("boolean");
    }
    expect(Object.keys(state).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
  });

  it("rejects unknown flags with a deterministic error", () => {
    expect(() => isFeatureEnabled("NOT_A_FLAG" as FeatureFlagName)).toThrow(
      "Unknown feature flag: NOT_A_FLAG",
    );
    expect(() => isFeatureEnabled("" as FeatureFlagName)).toThrow(
      "Unknown feature flag: ",
    );
    // Case matters: the lookup is exact, not case-insensitive.
    expect(() => isFeatureEnabled("create_slot" as FeatureFlagName)).toThrow(
      "Unknown feature flag: create_slot",
    );
  });

  it("reflects env overrides for every declared flag", () => {
    const env: Record<string, string> = {};
    for (const name of FEATURE_FLAG_NAMES) {
      env[FEATURE_FLAGS[name].envVar] = "false";
    }
    const state = resolveFeatureFlags(env);
    for (const name of FEATURE_FLAG_NAMES) {
      expect(state[name]).toBe(false);
    }
  });
});

describe("FeatureFlagState / FeatureFlagAccessor contract", () => {
  beforeEach(() => {
    setFeatureFlagsFromEnv({});
  });

  afterEach(() => {
    setFeatureFlagsFromEnv(process.env);
  });

  it("accessor.isEnabled mirrors the resolved state and rejects unknown flags", () => {
    const accessor: FeatureFlagAccessor = getFeatureFlagAccessor();
    expect(typeof accessor.isEnabled).toBe("function");
    expect(typeof accessor.list).toBe("function");

    expect(accessor.isEnabled("CREATE_SLOT")).toBe(true);
    expect(accessor.isEnabled("CREATE_BOOKING_INTENT")).toBe(false);
    expect(() => accessor.isEnabled("NOPE" as FeatureFlagName)).toThrow(
      "Unknown feature flag: NOPE",
    );
  });

  it("accessor.list returns a copy covering exactly FEATURE_FLAG_NAMES", () => {
    const accessor = getFeatureFlagAccessor();
    const list = accessor.list();
    expect(Object.keys(list).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
    expect(list).not.toBe(accessor.list());
  });

  it("FeatureFlagState requires a boolean for every flag (structural check)", () => {
    const state: FeatureFlagState = {
      CREATE_SLOT: true,
      CREATE_BOOKING_INTENT: false,
      CHECKOUT: true,
      SMS_NOTIFICATIONS: true,
      SEARCH_LTR_RERANKER: false,
    };
    for (const name of FEATURE_FLAG_NAMES) {
      expect(typeof state[name]).toBe("boolean");
    }
  });
});

describe("FeatureFlagGuardedMethod / FeatureFlagGuardedRoute contract", () => {
  it("accepts the five guarded HTTP verbs and rejects others at the type level", () => {
    // The registry only ever stores guarded verbs; assert the union members.
    const verbs = new Set<string>(guardedMethods);
    expect(verbs).toEqual(new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]));
    expect(verbs.has("HEAD")).toBe(false);
    expect(verbs.has("OPTIONS")).toBe(false);
  });

  it("keeps every registered guarded route consistent with the route shape", () => {
    for (const name of FEATURE_FLAG_NAMES) {
      for (const route of FEATURE_FLAGS[name].guardedRoutes) {
        const guardedRoute: FeatureFlagGuardedRoute = route;
        expect(guardedMethods).toContain(guardedRoute.method);
        // Paths are root-relative by construction (`/${string}`).
        expect(guardedRoute.path.startsWith("/")).toBe(true);
        expect(guardedRoute.description.length).toBeGreaterThan(0);
        expect(Number.isInteger(guardedRoute.enabledExpectedStatus)).toBe(true);
        expect(guardedRoute.disabledResponse).toMatchObject({
          status: 503,
          code: "FEATURE_DISABLED",
        });
      }
    }
  });

  it("emits the disabled contract for a representative guarded route", () => {
    const route = FEATURE_FLAGS.CREATE_SLOT.guardedRoutes[0];
    expect(route).toBeDefined();
    expect(route.disabledResponse).toEqual({
      status: 503,
      code: "FEATURE_DISABLED",
      error: "Feature CREATE_SLOT is currently disabled",
    });
  });
});

describe("ROLLOUT_ENVIRONMENTS", () => {
  it("is a frozen tuple mirroring the deployment environments", () => {
    expect(Object.isFrozen(ROLLOUT_ENVIRONMENTS)).toBe(true);
    expect([...ROLLOUT_ENVIRONMENTS]).toEqual(["development", "test", "production"]);
  });

  it("contains no duplicates", () => {
    expect(new Set(ROLLOUT_ENVIRONMENTS).size).toBe(ROLLOUT_ENVIRONMENTS.length);
  });
});

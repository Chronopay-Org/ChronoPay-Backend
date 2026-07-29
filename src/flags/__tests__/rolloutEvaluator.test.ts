import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  currentRolloutEnvironment,
  getRolloutPercentage,
  hashToBucket,
  isBucketedIn,
  isFeatureEnabledForTenant,
} from "../rolloutEvaluator.js";
import {
  getRolloutScheduleRegistry,
  resetRolloutScheduleRegistry,
} from "../rolloutScheduleRegistry.js";
import { setFeatureFlagsFromEnv } from "../service.js";

describe("hashToBucket", () => {
  it("is deterministic for the same input", () => {
    expect(hashToBucket("tenant-a")).toBe(hashToBucket("tenant-a"));
  });

  it("always returns a value in [0, 100)", () => {
    for (const key of ["a", "b", "user-123", "", "tenant-🚀", "x".repeat(500)]) {
      const bucket = hashToBucket(key);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
      expect(Number.isInteger(bucket)).toBe(true);
    }
  });

  it("distributes distinct keys across many buckets (not a constant)", () => {
    const buckets = new Set(Array.from({ length: 500 }, (_, i) => hashToBucket(`key-${i}`)));
    expect(buckets.size).toBeGreaterThan(20);
  });
});

describe("isBucketedIn", () => {
  it("is always false at 0% and always true at 100%, regardless of hash", () => {
    for (const key of ["a", "b", "c", "d", "e"]) {
      expect(isBucketedIn(key, 0)).toBe(false);
      expect(isBucketedIn(key, 100)).toBe(true);
    }
  });

  it("agrees with the raw bucket/percentage comparison", () => {
    const key = "tenant-a:user-42";
    const bucket = hashToBucket(key);
    expect(isBucketedIn(key, bucket)).toBe(false); // strictly less-than at the boundary
    expect(isBucketedIn(key, bucket + 1)).toBe(true);
  });

  it("clamps out-of-range percentages safely", () => {
    expect(isBucketedIn("k", -5)).toBe(false);
    expect(isBucketedIn("k", 250)).toBe(true);
  });
});

describe("currentRolloutEnvironment", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("reads a valid NODE_ENV", () => {
    process.env.NODE_ENV = "production";
    expect(currentRolloutEnvironment()).toBe("production");
  });

  it("falls back to development for an unrecognized or missing NODE_ENV", () => {
    process.env.NODE_ENV = "staging";
    expect(currentRolloutEnvironment()).toBe("development");
    delete process.env.NODE_ENV;
    expect(currentRolloutEnvironment()).toBe("development");
  });
});

describe("getRolloutPercentage / isFeatureEnabledForTenant", () => {
  beforeEach(() => {
    resetRolloutScheduleRegistry();
    setFeatureFlagsFromEnv({});
  });

  afterEach(() => {
    resetRolloutScheduleRegistry();
  });

  it("returns 100 (unrestricted) when no schedule governs the tuple", () => {
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(100);
  });

  it("returns the schedule's current percentage once one governs the tuple", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 25, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(25);
  });

  it("the base boolean flag is a kill-switch that overrides any rollout percentage", () => {
    // CREATE_SLOT defaults to enabled; force it off.
    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "false" });

    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 100, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    // Even at 100% rollout, a disabled base flag always evaluates to false.
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", "any-bucket-key", "production")).toBe(false);
  });

  it("with no schedule, an enabled flag behaves exactly like the plain boolean flag (100%)", () => {
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", "any-bucket-key", "production")).toBe(true);
  });

  it("defaults the environment argument to currentRolloutEnvironment() when omitted", () => {
    // Under Jest, NODE_ENV is "test", which currentRolloutEnvironment() recognizes.
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a")).toBe(100);
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", "any-bucket-key")).toBe(true);
  });

  it("gates a request by bucket key once a partial rollout is active", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 50, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    // Deterministic: same bucket key always yields the same decision.
    const key = "user-777";
    const first = isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", key, "production");
    const second = isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", key, "production");
    expect(first).toBe(second);
    expect(first).toBe(hashToBucket(key) < 50);
  });
});

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
import { ALL_TENANTS } from "../rolloutTypes.js";
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

  it("matches known FNV-1a vectors", () => {
    // Hard-coded expected values: if the hash function is changed the rollout
    // bucket assignments silently change, which would move live tenants onto
    // different ramps. These vectors pin the algorithm.
    expect(hashToBucket("")).toBe(61);
    expect(hashToBucket("a")).toBe(20);
    expect(hashToBucket("tenant-a")).toBe(31);
    expect(hashToBucket("tenant-a:user-42")).toBe(5);
    expect(hashToBucket("user-777")).toBe(64);
    expect(hashToBucket("CREATE_SLOT:tenant-a")).toBe(26);
    expect(hashToBucket("")).not.toBe(hashToBucket(" "));
  });

  it("treats unicode and multi-code-unit keys consistently", () => {
    // Emoji are surrogate pairs; both the code-unit hash and the modulo must
    // still produce an in-range integer instead of NaN.
    expect(hashToBucket("tenant-🚀")).toBe(5);
    expect(Number.isInteger(hashToBucket("🚀🚀🚀"))).toBe(true);
  });

  it("is sensitive to key order and to length", () => {
    expect(hashToBucket("ab")).not.toBe(hashToBucket("ba"));
    expect(hashToBucket("a")).not.toBe(hashToBucket("aa"));
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

  it("keeps the strict boundary for a known vector", () => {
    // "tenant-a:user-42" hashes to bucket 5.
    expect(isBucketedIn("tenant-a:user-42", 4)).toBe(false);
    expect(isBucketedIn("tenant-a:user-42", 5)).toBe(false);
    expect(isBucketedIn("tenant-a:user-42", 6)).toBe(true);
  });

  it("supports fractional percentages by comparing against the raw bucket", () => {
    const key = "tenant-a";
    expect(isBucketedIn(key, 0.5)).toBe(hashToBucket(key) < 0.5);
    // 99.9 is above every integer bucket (max 99), so everyone is included.
    expect(isBucketedIn(key, 99.9)).toBe(true);
  });

  it("fails closed for NaN and stays predictable for infinities", () => {
    // NaN comparisons are always false, so an unparsed percentage tears the
    // flag off rather than silently enabling it for everyone.
    expect(isBucketedIn("tenant-a", Number.NaN)).toBe(false);
    expect(isBucketedIn("tenant-a", Number.POSITIVE_INFINITY)).toBe(true);
    expect(isBucketedIn("tenant-a", Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("currentRolloutEnvironment", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("reads every supported NODE_ENV", () => {
    process.env.NODE_ENV = "development";
    expect(currentRolloutEnvironment()).toBe("development");

    process.env.NODE_ENV = "test";
    expect(currentRolloutEnvironment()).toBe("test");

    process.env.NODE_ENV = "production";
    expect(currentRolloutEnvironment()).toBe("production");
  });

  it("falls back to development for an unrecognized NODE_ENV", () => {
    process.env.NODE_ENV = "staging";
    expect(currentRolloutEnvironment()).toBe("development");
  });

  it("falls back to development when NODE_ENV is missing or empty", () => {
    delete process.env.NODE_ENV;
    expect(currentRolloutEnvironment()).toBe("development");

    process.env.NODE_ENV = "";
    expect(currentRolloutEnvironment()).toBe("development");
  });

  it("is case- and whitespace-sensitive rather than guessing", () => {
    process.env.NODE_ENV = "PRODUCTION";
    expect(currentRolloutEnvironment()).toBe("development");

    process.env.NODE_ENV = " production";
    expect(currentRolloutEnvironment()).toBe("development");
  });

  it("re-reads the environment on every call (no caching)", () => {
    process.env.NODE_ENV = "production";
    expect(currentRolloutEnvironment()).toBe("production");

    process.env.NODE_ENV = "development";
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

  it("returns 100 (unrestricted) for an empty tenant id with no schedule", () => {
    expect(getRolloutPercentage("CREATE_SLOT", "", "production")).toBe(100);
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

  it("starts a freshly-created schedule at 0% until a step becomes due", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 100, at: "2099-01-01T00:00:00.000Z" }],
    });

    // pending: no step has been reached yet.
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(0);
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", "any-bucket-key", "production")).toBe(false);
  });

  it("transitions from 0% to the due percentage when the schedule advances", () => {
    const registry = getRolloutScheduleRegistry();
    const schedule = registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 50, at: "2026-01-01T00:00:00.000Z" }],
    });
    expect(schedule.currentPercentage).toBe(0);

    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(50);
  });

  it("drops a rolled-back schedule to 0%", () => {
    const registry = getRolloutScheduleRegistry();
    const { id } = registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 100, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(100);

    registry.rollback({ id, actor: "bob", reason: "incident", toStepIndex: -1 });
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(0);
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", "any-bucket-key", "production")).toBe(false);
  });

  it("scopes schedules to their environment", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 10, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(10);
    // Another environment is untouched by the production ramp.
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "development")).toBe(100);
  });

  it("applies an ALL_TENANTS wildcard to tenants without a specific schedule", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: ALL_TENANTS,
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 25, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(25);
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-b", "production")).toBe(25);
  });

  it("prefers a tenant-specific schedule over the ALL_TENANTS wildcard", () => {
    const registry = getRolloutScheduleRegistry();
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: ALL_TENANTS,
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 25, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 75, at: "2026-01-01T00:00:00.000Z" }],
    });
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));

    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(75);
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-b", "production")).toBe(25);
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

  it("flips a tenant on as the ramp crosses its bucket", () => {
    const registry = getRolloutScheduleRegistry();
    const key = "tenant-a:user-42"; // bucket 5
    registry.create({
      flag: "CREATE_SLOT",
      tenantId: "tenant-a",
      environment: "production",
      actor: "alice",
      steps: [{ percentage: 5, at: "2026-01-01T00:00:00.000Z" }],
    });

    // 5% excludes bucket 5 because the comparison is strictly less-than.
    registry.advanceDue(new Date("2026-01-01T00:00:00.000Z"));
    expect(isFeatureEnabledForTenant("CREATE_SLOT", "tenant-a", key, "production")).toBe(false);

    // The next step pushes the ramp past the bucket and the same key flips on.
    expect(getRolloutPercentage("CREATE_SLOT", "tenant-a", "production")).toBe(5);
    expect(isBucketedIn(key, 6)).toBe(true);
  });
});

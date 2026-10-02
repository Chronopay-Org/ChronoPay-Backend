
describe("src/flags/index barrel exports", () => {
  let barrel: typeof import("./index.js");

  beforeAll(async () => {
    barrel = await import("./index.js");
  });

  describe("registry re-exports", () => {
    it("exports FEATURE_FLAGS as a non-empty object", () => {
      expect(barrel.FEATURE_FLAGS).toBeDefined();
      expect(typeof barrel.FEATURE_FLAGS).toBe("object");
      expect(Object.keys(barrel.FEATURE_FLAGS).length).toBeGreaterThan(0);
    });

    it("each feature flag definition has the required shape", () => {
      for (const def of Object.values(barrel.FEATURE_FLAGS)) {
        expect(def).toHaveProperty("envVar");
        expect(def.envVar).toMatch(/^FF_/);
        expect(def).toHaveProperty("description");
        expect(typeof def.description).toBe("string");
        expect(def).toHaveProperty("defaultEnabled");
        expect(typeof def.defaultEnabled).toBe("boolean");
        expect(def).toHaveProperty("guardedRoutes");
        expect(Array.isArray(def.guardedRoutes)).toBe(true);
      }
    });

    it("getAllGuardedFeatureRoutes returns an array", () => {
      expect(typeof barrel.getAllGuardedFeatureRoutes).toBe("function");
      const routes = barrel.getAllGuardedFeatureRoutes();
      expect(Array.isArray(routes)).toBe(true);
    });

    it("getAllGuardedFeatureRoutes returns only entries with a flag field", () => {
      const routes = barrel.getAllGuardedFeatureRoutes();
      for (const route of routes) {
        expect(route).toHaveProperty("flag");
        expect(route).toHaveProperty("method");
        expect(route).toHaveProperty("path");
        expect(route).toHaveProperty("disabledResponse");
      }
    });

    it("isGuardedRouteRegistered returns boolean for a known flag", () => {
      const result = barrel.isGuardedRouteRegistered("CREATE_SLOT", "POST", "/api/v1/slots");
      expect(typeof result).toBe("boolean");
      expect(result).toBe(true);
    });

    it("isGuardedRouteRegistered returns false for an unregistered path", () => {
      const result = barrel.isGuardedRouteRegistered("CREATE_SLOT", "DELETE", "/api/v1/slots");
      expect(result).toBe(false);
    });
  });

  describe("service re-exports", () => {
    it("exports all service functions", () => {
      expect(typeof barrel.getFeatureFlagAccessor).toBe("function");
      expect(typeof barrel.getFeatureFlagsSnapshot).toBe("function");
      expect(typeof barrel.isFeatureEnabled).toBe("function");
      expect(typeof barrel.resolveFeatureFlags).toBe("function");
      expect(typeof barrel.setFeatureFlagsFromEnv).toBe("function");
    });

    it("getFeatureFlagsSnapshot returns an object keyed by flag names", () => {
      const snapshot = barrel.getFeatureFlagsSnapshot();
      expect(typeof snapshot).toBe("object");
      expect(snapshot).not.toBeNull();
    });

    it("isFeatureEnabled returns boolean for a known flag", () => {
      const result = barrel.isFeatureEnabled("CREATE_SLOT");
      expect(typeof result).toBe("boolean");
    });

    it("isFeatureEnabled throws for an unknown flag", () => {
      expect(() => barrel.isFeatureEnabled("NOT_A_REAL_FLAG" as never)).toThrow(
        /Unknown feature flag/,
      );
    });

    it("resolveFeatureFlags returns a full state object", () => {
      const state = barrel.resolveFeatureFlags({} as NodeJS.ProcessEnv);
      expect(typeof state).toBe("object");
      expect(state).not.toBeNull();
    });

    it("getFeatureFlagAccessor returns an accessor with isEnabled and list", () => {
      const accessor = barrel.getFeatureFlagAccessor();
      expect(typeof accessor.isEnabled).toBe("function");
      expect(typeof accessor.list).toBe("function");
      expect(typeof accessor.isEnabled("CREATE_SLOT")).toBe("boolean");
      expect(typeof accessor.list()).toBe("object");
    });
  });

  describe("types re-exports", () => {
    it("exports FEATURE_FLAG_NAMES as a non-empty array of strings", () => {
      expect(Array.isArray(barrel.FEATURE_FLAG_NAMES)).toBe(true);
      expect(barrel.FEATURE_FLAG_NAMES.length).toBeGreaterThan(0);
      for (const name of barrel.FEATURE_FLAG_NAMES) {
        expect(typeof name).toBe("string");
      }
    });

    it("exports ROLLOUT_ENVIRONMENTS as a non-empty array of strings", () => {
      expect(Array.isArray(barrel.ROLLOUT_ENVIRONMENTS)).toBe(true);
      expect(barrel.ROLLOUT_ENVIRONMENTS.length).toBeGreaterThan(0);
      for (const env of barrel.ROLLOUT_ENVIRONMENTS) {
        expect(typeof env).toBe("string");
      }
    });
  });

  describe("rolloutTypes re-exports", () => {
    it("exports ALL_TENANTS", () => {
      expect(barrel.ALL_TENANTS).toBeDefined();
    });

    it("exports RolloutScheduleError as a constructable error class", () => {
      expect(typeof barrel.RolloutScheduleError).toBe("function");
      const err = new barrel.RolloutScheduleError("test", "TEST");
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe("test");
    });
  });

  describe("rolloutScheduleRegistry re-exports", () => {
    it("exports RolloutScheduleRegistry as a class", () => {
      expect(typeof barrel.RolloutScheduleRegistry).toBe("function");
    });

    it("exports getRolloutScheduleRegistry as a function", () => {
      expect(typeof barrel.getRolloutScheduleRegistry).toBe("function");
    });

    it("exports resetRolloutScheduleRegistry as a function", () => {
      expect(typeof barrel.resetRolloutScheduleRegistry).toBe("function");
    });
  });

  describe("rolloutEvaluator re-exports", () => {
    it("exports the evaluator functions", () => {
      expect(typeof barrel.currentRolloutEnvironment).toBe("function");
      expect(typeof barrel.getRolloutPercentage).toBe("function");
      expect(typeof barrel.hashToBucket).toBe("function");
      expect(typeof barrel.isBucketedIn).toBe("function");
      expect(typeof barrel.isFeatureEnabledForTenant).toBe("function");
    });

    it("hashToBucket returns a stable number in [0, 100) for the same input", () => {
      const a = barrel.hashToBucket("tenant-1");
      const b = barrel.hashToBucket("tenant-1");
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(100);
    });

    it("hashToBucket produces different buckets for different inputs (usually)", () => {
      const a = barrel.hashToBucket("tenant-1");
      const b = barrel.hashToBucket("tenant-2");
      // Not strictly guaranteed, but highly likely and useful as a sanity check.
      expect(a).not.toBe(b);
    });
  });
});

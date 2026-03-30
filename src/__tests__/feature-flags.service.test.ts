import {
  getFeatureFlagAccessor,
  resolveFeatureFlags,
  setFeatureFlagsFromEnv,
} from "../flags/index.js";

describe("feature flag service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    setFeatureFlagsFromEnv(process.env);
  });

  it("uses defaults when env variables are missing", () => {
    const state = resolveFeatureFlags({});

    expect(state.CREATE_SLOT).toBe(true);
  });

  it("parses disabled values", () => {
    const values = ["false", "0", "off", "no"];

    for (const value of values) {
      const state = resolveFeatureFlags({ FF_CREATE_SLOT: value });
      expect(state.CREATE_SLOT).toBe(false);
    }
  });

  it("parses enabled values", () => {
    const values = ["true", "1", "on", "yes", " TRUE "];

    for (const value of values) {
      const state = resolveFeatureFlags({ FF_CREATE_SLOT: value });
      expect(state.CREATE_SLOT).toBe(true);
    }
  });

  it("throws for malformed values", () => {
    expect(() => resolveFeatureFlags({ FF_CREATE_SLOT: "enabled" })).toThrow(
      /Invalid value for FF_CREATE_SLOT/,
    );
  });

  it("throws on unknown flag lookups", () => {
    const accessor = getFeatureFlagAccessor();

    expect(() => accessor.isEnabled("UNKNOWN_FLAG" as never)).toThrow(
      /Unknown feature flag/,
    );
  });

  it("exposes enabled state through accessor snapshot methods", () => {
    setFeatureFlagsFromEnv({ ...process.env, FF_CREATE_SLOT: "false" });
    const accessor = getFeatureFlagAccessor();

    expect(accessor.isEnabled("CREATE_SLOT")).toBe(false);
    expect(accessor.list()).toEqual({ CREATE_SLOT: false });
  });
});

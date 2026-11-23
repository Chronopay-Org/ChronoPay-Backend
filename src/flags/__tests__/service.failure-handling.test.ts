/**
 * Feature-flag service — failure-handling regression coverage.
 *
 * `resolveFeatureFlags` is the single parse point for `FF_*` environment
 * variables and is documented to fail closed at startup. This suite pins the
 * failure contract so a refactor cannot silently accept malformed values, and
 * proves `setFeatureFlagsFromEnv` is fail-safe: a rejected parse must not
 * partially overwrite the previously active flags.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";

beforeEach(() => {
  delete process.env.FF_CREATE_SLOT;
  delete process.env.FF_CREATE_BOOKING_INTENT;
  delete process.env.FF_SMS_NOTIFICATIONS;
  delete process.env.FF_SEARCH_LTR_RERANKER;
});

describe("resolveFeatureFlags failure handling", () => {
  it("rejects malformed literals and reports the env var plus raw value", async () => {
    const { resolveFeatureFlags } = await import("../service.js");

    let message = "";
    try {
      resolveFeatureFlags({ FF_CREATE_SLOT: "maybe" });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain("FF_CREATE_SLOT");
    expect(message).toContain("maybe");
    expect(message).toContain("true/false");
  });

  it.each(["", "   ", "2", "-1", "enabled"])(
    "rejects the unsupported value %p",
    async (value) => {
      const { resolveFeatureFlags } = await import("../service.js");
      expect(() => resolveFeatureFlags({ FF_CREATE_SLOT: value })).toThrow(
        /Invalid value for FF_CREATE_SLOT/,
      );
    },
  );

  it("trims and lower-cases accepted literals", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    const on = resolveFeatureFlags({ FF_CREATE_BOOKING_INTENT: "  TRUE  " });
    expect(on.CREATE_BOOKING_INTENT).toBe(true);

    const off = resolveFeatureFlags({ FF_CREATE_SLOT: " Off " });
    expect(off.CREATE_SLOT).toBe(false);

    const yesOn = resolveFeatureFlags({ FF_CREATE_SLOT: "\tYes\n" });
    expect(yesOn.CREATE_SLOT).toBe(true);

    const zero = resolveFeatureFlags({ FF_CREATE_BOOKING_INTENT: "0" });
    expect(zero.CREATE_BOOKING_INTENT).toBe(false);
  });

  it("returns a complete state for every registered flag when env is empty", async () => {
    const { resolveFeatureFlags } = await import("../service.js");
    const { FEATURE_FLAG_NAMES } = await import("../types.js");

    const state = resolveFeatureFlags({});
    for (const flag of FEATURE_FLAG_NAMES) {
      expect(state).toHaveProperty(flag);
      expect(typeof state[flag]).toBe("boolean");
    }
  });
});

describe("setFeatureFlagsFromEnv is fail-safe", () => {
  it("leaves the previous flags untouched when the new env is malformed", async () => {
    const { setFeatureFlagsFromEnv, getFeatureFlagAccessor } = await import("../service.js");

    setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "false" });
    expect(getFeatureFlagAccessor().list().CREATE_SLOT).toBe(false);

    expect(() => setFeatureFlagsFromEnv({ FF_CREATE_SLOT: "definitely" })).toThrow(
      /Invalid value for FF_CREATE_SLOT/,
    );

    // The rejected parse must not have partially applied the new state.
    expect(getFeatureFlagAccessor().list().CREATE_SLOT).toBe(false);
  });

  it("applies the whole state only after a fully successful parse", async () => {
    const { setFeatureFlagsFromEnv, getFeatureFlagAccessor } = await import("../service.js");

    setFeatureFlagsFromEnv({
      FF_CREATE_SLOT: "0",
      FF_CREATE_BOOKING_INTENT: "1",
    });

    const list = getFeatureFlagAccessor().list();
    expect(list.CREATE_SLOT).toBe(false);
    expect(list.CREATE_BOOKING_INTENT).toBe(true);
  });

  it("rejects unknown flag names at read time", async () => {
    const { isFeatureEnabled } = await import("../service.js");
    expect(() => isFeatureEnabled("NOT_A_FLAG" as never)).toThrow(
      "Unknown feature flag: NOT_A_FLAG",
    );
  });
});

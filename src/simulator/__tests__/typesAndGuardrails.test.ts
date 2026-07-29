/**
 * Tests for simulator types (Zod schemas) and safety guardrails.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  TrafficSampleSchema,
  TrafficCurveSchema,
  SimulatorConfigSchema,
} from "../../simulator/types.js";
import {
  BLOCKED_STELLAR_HOSTS,
  SIMULATOR_SAFE_MARKER,
  SimulationSafetyError,
  assertSimulationSafe,
  findBlockedHost,
} from "../../simulator/safetyGuardrails.js";
import { buildSyntheticCurve } from "../../simulator/trafficIngester.js";

// ---------------------------------------------------------------------------
// Zod schema tests
// ---------------------------------------------------------------------------

describe("TrafficSampleSchema", () => {
  const validSample = {
    timestampMs: 1_700_000_000_000,
    route: "booking_intent",
    requestCount: 120,
    errorCount: 1,
    p99LatencyMs: 95.5,
  };

  it("accepts a valid sample", () => {
    expect(() => TrafficSampleSchema.parse(validSample)).not.toThrow();
  });

  it("rejects negative timestampMs", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, timestampMs: -1 }),
    ).toThrow();
  });

  it("rejects non-integer timestampMs", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, timestampMs: 1.5 }),
    ).toThrow();
  });

  it("rejects unknown route", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, route: "unknown_route" }),
    ).toThrow();
  });

  it("rejects negative requestCount", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, requestCount: -1 }),
    ).toThrow();
  });

  it("rejects negative errorCount", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, errorCount: -1 }),
    ).toThrow();
  });

  it("rejects negative p99LatencyMs", () => {
    expect(() =>
      TrafficSampleSchema.parse({ ...validSample, p99LatencyMs: -0.1 }),
    ).toThrow();
  });

  it("accepts zero errorCount", () => {
    const result = TrafficSampleSchema.parse({ ...validSample, errorCount: 0 });
    expect(result.errorCount).toBe(0);
  });

  it("accepts all valid routes", () => {
    const routes = ["booking_intent", "slots_list", "checkout", "escrow_listener"];
    for (const route of routes) {
      expect(() => TrafficSampleSchema.parse({ ...validSample, route })).not.toThrow();
    }
  });
});

describe("TrafficCurveSchema", () => {
  const validCurve = {
    label: "peak-test",
    startIso: "2026-07-28T00:00:00.000Z",
    endIso: "2026-07-28T01:00:00.000Z",
    samples: [
      {
        timestampMs: 1_753_660_800_000,
        route: "slots_list",
        requestCount: 50,
        errorCount: 0,
        p99LatencyMs: 60,
      },
    ],
  };

  it("accepts a valid curve", () => {
    expect(() => TrafficCurveSchema.parse(validCurve)).not.toThrow();
  });

  it("rejects empty label", () => {
    expect(() => TrafficCurveSchema.parse({ ...validCurve, label: "" })).toThrow();
  });

  it("rejects invalid startIso", () => {
    expect(() =>
      TrafficCurveSchema.parse({ ...validCurve, startIso: "not-a-date" }),
    ).toThrow();
  });

  it("rejects empty samples array", () => {
    expect(() => TrafficCurveSchema.parse({ ...validCurve, samples: [] })).toThrow();
  });
});

describe("SimulatorConfigSchema", () => {
  it("applies defaults when given empty object", () => {
    const config = SimulatorConfigSchema.parse({});
    expect(config.scaleFactor).toBe(1.0);
    expect(config.maxDurationMs).toBe(60_000);
    expect(config.dryRun).toBe(true);
    expect(config.seed).toBeUndefined();
  });

  it("accepts a valid full config", () => {
    const config = SimulatorConfigSchema.parse({
      scaleFactor: 2.5,
      maxDurationMs: 120_000,
      seed: 42,
      dryRun: false,
    });
    expect(config.scaleFactor).toBe(2.5);
    expect(config.seed).toBe(42);
    expect(config.dryRun).toBe(false);
  });

  it("rejects zero scaleFactor", () => {
    expect(() => SimulatorConfigSchema.parse({ scaleFactor: 0 })).toThrow();
  });

  it("rejects negative maxDurationMs", () => {
    expect(() => SimulatorConfigSchema.parse({ maxDurationMs: -1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Safety guardrails tests
// ---------------------------------------------------------------------------

describe("SIMULATOR_SAFE_MARKER", () => {
  it("is exported and non-empty", () => {
    expect(SIMULATOR_SAFE_MARKER).toBe("SIMULATOR_SAFE_v1");
  });
});

describe("BLOCKED_STELLAR_HOSTS", () => {
  it("includes mainnet and testnet horizon hosts", () => {
    expect(BLOCKED_STELLAR_HOSTS.has("horizon.stellar.org")).toBe(true);
    expect(BLOCKED_STELLAR_HOSTS.has("horizon-testnet.stellar.org")).toBe(true);
  });
});

describe("findBlockedHost", () => {
  it("returns the host when URL is on the blocklist", () => {
    expect(findBlockedHost("https://horizon.stellar.org/transactions")).toBe(
      "horizon.stellar.org",
    );
  });

  it("returns null for a safe URL", () => {
    expect(findBlockedHost("http://localhost:3001/api/v1")).toBeNull();
  });

  it("returns null for a non-URL string (curve label)", () => {
    expect(findBlockedHost("peak-2026-07-28")).toBeNull();
  });

  it("returns the host for testnet Horizon", () => {
    expect(
      findBlockedHost("https://horizon-testnet.stellar.org/accounts/GABC"),
    ).toBe("horizon-testnet.stellar.org");
  });

  it("is case-insensitive for hostname", () => {
    expect(findBlockedHost("https://HORIZON.STELLAR.ORG")).toBe(
      "horizon.stellar.org",
    );
  });

  it("returns null for an invalid/empty URL", () => {
    expect(findBlockedHost("not a url at all")).toBeNull();
    expect(findBlockedHost("")).toBeNull();
  });
});

describe("assertSimulationSafe", () => {
  const safeCurve = buildSyntheticCurve({ label: "safe-label" });

  let originalNodeEnv: string | undefined;
  let originalHorizonUrl: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalHorizonUrl = process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_HORIZON_URL;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalHorizonUrl === undefined) {
      delete process.env.STELLAR_HORIZON_URL;
    } else {
      process.env.STELLAR_HORIZON_URL = originalHorizonUrl;
    }
  });

  it("passes for a safe curve in test environment", () => {
    process.env.NODE_ENV = "test";
    expect(() => assertSimulationSafe(safeCurve)).not.toThrow();
  });

  it("throws SimulationSafetyError in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertSimulationSafe(safeCurve)).toThrow(SimulationSafetyError);
  });

  it("throws when STELLAR_HORIZON_URL points to mainnet", () => {
    process.env.NODE_ENV = "test";
    process.env.STELLAR_HORIZON_URL = "https://horizon.stellar.org";
    expect(() => assertSimulationSafe(safeCurve)).toThrow(SimulationSafetyError);
  });

  it("does NOT throw when STELLAR_HORIZON_URL is set to a safe value", () => {
    process.env.NODE_ENV = "test";
    process.env.STELLAR_HORIZON_URL = "http://localhost:8000";
    expect(() => assertSimulationSafe(safeCurve)).not.toThrow();
  });

  it("throws when curve label is a blocked Stellar URL", () => {
    process.env.NODE_ENV = "test";
    const blockedCurve = {
      ...safeCurve,
      label: "https://horizon.stellar.org",
    };
    expect(() => assertSimulationSafe(blockedCurve)).toThrow(SimulationSafetyError);
  });

  it("SimulationSafetyError has correct name", () => {
    process.env.NODE_ENV = "production";
    try {
      assertSimulationSafe(safeCurve);
    } catch (e) {
      expect(e).toBeInstanceOf(SimulationSafetyError);
      expect((e as SimulationSafetyError).name).toBe("SimulationSafetyError");
    }
  });
});

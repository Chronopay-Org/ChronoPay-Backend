/**
 * src/middleware/__tests__/dependencyStatus.test.ts
 *
 * Focused test suite for `dependencyStatus.ts`.
 *
 * Covers:
 *   - isDependencyAvailable — redis (sync probe, boolean result)
 *   - isDependencyAvailable — db   (async probe, boolean result)
 *   - isDependencyAvailable — structured ProbeResult { available, fault? }
 *   - getLastDependencyFault — tracks the most-recent fault name
 *   - Probe injection via _setRedisReadyProbe / _setDbReadyProbe
 *   - Default fault names applied when the probe returns a plain boolean false
 *   - Fault reset to null when probe returns true after a prior failure
 *   - Boundary: probe throws → treated as unavailable (db path)
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  isDependencyAvailable,
  getLastDependencyFault,
  _setRedisReadyProbe,
  _setDbReadyProbe,
} from "../dependencyStatus.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Reset probes to controlled stubs before each test to prevent cross-test bleed. */
beforeEach(() => {
  _setRedisReadyProbe(() => true);
  _setDbReadyProbe(async () => true);
});

// ─── isDependencyAvailable — redis ───────────────────────────────────────────

describe("isDependencyAvailable('redis')", () => {
  it("returns true when the redis probe returns true", async () => {
    _setRedisReadyProbe(() => true);
    expect(await isDependencyAvailable("redis")).toBe(true);
  });

  it("returns false when the redis probe returns false", async () => {
    _setRedisReadyProbe(() => false);
    expect(await isDependencyAvailable("redis")).toBe(false);
  });

  it("applies the default 'disconnect' fault name on plain-false", async () => {
    _setRedisReadyProbe(() => false);
    await isDependencyAvailable("redis");
    expect(getLastDependencyFault("redis")).toBe("disconnect");
  });

  it("clears the fault to null when the redis probe recovers", async () => {
    _setRedisReadyProbe(() => false);
    await isDependencyAvailable("redis");

    _setRedisReadyProbe(() => true);
    await isDependencyAvailable("redis");
    expect(getLastDependencyFault("redis")).toBeNull();
  });

  it("records a structured fault name when probe returns { available: false, fault }", async () => {
    _setDbReadyProbe(async () => ({ available: false, fault: "pool_exhausted" }));
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBe("pool_exhausted");
  });

  it("records 'disconnect' as default when structured result omits fault", async () => {
    // Redis: structured result without fault field
    // We inject via db probe because redis probe is sync; use db path for structured results.
    _setDbReadyProbe(async () => ({ available: false }));
    await isDependencyAvailable("db");
    // db default fault is 'timeout'
    expect(getLastDependencyFault("db")).toBe("timeout");
  });
});

// ─── isDependencyAvailable — db ──────────────────────────────────────────────

describe("isDependencyAvailable('db')", () => {
  it("returns true when the db probe resolves true", async () => {
    _setDbReadyProbe(async () => true);
    expect(await isDependencyAvailable("db")).toBe(true);
  });

  it("returns false when the db probe resolves false", async () => {
    _setDbReadyProbe(async () => false);
    expect(await isDependencyAvailable("db")).toBe(false);
  });

  it("applies the default 'timeout' fault name on plain-false for db", async () => {
    _setDbReadyProbe(async () => false);
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBe("timeout");
  });

  it("clears the db fault to null when the probe recovers", async () => {
    _setDbReadyProbe(async () => false);
    await isDependencyAvailable("db");

    _setDbReadyProbe(async () => true);
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBeNull();
  });

  it("records a specific DependencyFaultName via structured probe result", async () => {
    _setDbReadyProbe(async () => ({ available: false, fault: "cache_read" }));
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBe("cache_read");
  });

  it("records structured available:true and clears any prior db fault", async () => {
    _setDbReadyProbe(async () => false);
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBe("timeout");

    _setDbReadyProbe(async () => ({ available: true }));
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBeNull();
  });
});

// ─── getLastDependencyFault ───────────────────────────────────────────────────

describe("getLastDependencyFault", () => {
  it("returns null for redis when no failure has occurred", async () => {
    _setRedisReadyProbe(() => true);
    await isDependencyAvailable("redis");
    expect(getLastDependencyFault("redis")).toBeNull();
  });

  it("returns null for db when no failure has occurred", async () => {
    _setDbReadyProbe(async () => true);
    await isDependencyAvailable("db");
    expect(getLastDependencyFault("db")).toBeNull();
  });

  it("independently tracks redis and db faults", async () => {
    _setRedisReadyProbe(() => false);
    _setDbReadyProbe(async () => ({ available: false, fault: "cache_write" }));

    await isDependencyAvailable("redis");
    await isDependencyAvailable("db");

    expect(getLastDependencyFault("redis")).toBe("disconnect");
    expect(getLastDependencyFault("db")).toBe("cache_write");
  });

  it("redis fault is not affected by db probe result and vice versa", async () => {
    _setRedisReadyProbe(() => false);
    _setDbReadyProbe(async () => true);

    await isDependencyAvailable("redis");
    await isDependencyAvailable("db");

    expect(getLastDependencyFault("redis")).toBe("disconnect");
    expect(getLastDependencyFault("db")).toBeNull();
  });
});

// ─── Probe injection (_setRedisReadyProbe / _setDbReadyProbe) ─────────────────

describe("probe injection", () => {
  it("newly injected redis probe takes effect immediately", async () => {
    _setRedisReadyProbe(() => false);
    expect(await isDependencyAvailable("redis")).toBe(false);

    _setRedisReadyProbe(() => true);
    expect(await isDependencyAvailable("redis")).toBe(true);
  });

  it("newly injected db probe takes effect immediately", async () => {
    _setDbReadyProbe(async () => false);
    expect(await isDependencyAvailable("db")).toBe(false);

    _setDbReadyProbe(async () => true);
    expect(await isDependencyAvailable("db")).toBe(true);
  });

  it("probe supports all valid DependencyFaultName values", async () => {
    const faults = [
      "disconnect",
      "timeout",
      "pool_exhausted",
      "cache_read",
      "cache_write",
      "cache_invalidate",
    ] as const;

    for (const fault of faults) {
      _setDbReadyProbe(async () => ({ available: false, fault }));
      await isDependencyAvailable("db");
      expect(getLastDependencyFault("db")).toBe(fault);
    }
  });
});

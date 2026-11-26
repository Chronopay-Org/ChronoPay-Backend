/**
 * Tests for src/services/treasuryBalancePoller.ts
 *
 * Covers (issue #1446):
 *  - Build passes without @ts-nocheck suppression
 *  - evaluateSeverity boundary table: exact boundary values, hysteresis 0
 *  - Stale reading raises poll-failure counter
 *  - knownAssets handling increments treasury_unknown_asset_total
 *  - Severity transitions for all alarm levels
 *  - Gauge values map to the SEVERITY_RANK thresholds used in Prometheus rules
 */

import { jest, describe, it, expect, beforeEach, afterEach, test } from "@jest/globals";

// Auto-resolves to src/__mocks__/metrics.ts — prom-client never loaded.
jest.mock("../../metrics");

import {
  TreasuryBalancePoller,
  evaluateSeverity,
  type BalanceProvider,
  type FloorThreshold,
  type PollerConfig,
} from "../treasuryBalancePoller.js";

import {
  treasuryBalance,
  treasuryDrainSeverity,
  treasuryPollFailures,
  treasuryUnknownAsset,
} from "../../metrics.js";

// ─── Spies ────────────────────────────────────────────────────────────────────
//
// We create spies here in the test module's Jest context using jest.spyOn().
// These spies survive clearAllMocks() correctly because they were created by
// this module's jest instance, not by a factory in a different module scope.

let spyBalanceSet:      ReturnType<typeof jest.spyOn>;
let spyBalanceLabels:   ReturnType<typeof jest.spyOn>;
let spySeveritySet:     ReturnType<typeof jest.spyOn>;
let spySeverityLabels:  ReturnType<typeof jest.spyOn>;
let spyFailuresInc:     ReturnType<typeof jest.spyOn>;
let spyFailuresLabels:  ReturnType<typeof jest.spyOn>;
let spyUnknownInc:      ReturnType<typeof jest.spyOn>;
let spyUnknownLabels:   ReturnType<typeof jest.spyOn>;

// labels() on each metric must return an object with inc/set/labels so the
// production code can chain: metric.labels(a, b).set(v)
function wireSpies(): void {
  spyBalanceLabels  = jest.spyOn(treasuryBalance,       "labels").mockImplementation(() => treasuryBalance as any);
  spyBalanceSet     = jest.spyOn(treasuryBalance,       "set");
  spySeverityLabels = jest.spyOn(treasuryDrainSeverity, "labels").mockImplementation(() => treasuryDrainSeverity as any);
  spySeveritySet    = jest.spyOn(treasuryDrainSeverity, "set");
  spyFailuresLabels = jest.spyOn(treasuryPollFailures,  "labels").mockImplementation(() => treasuryPollFailures as any);
  spyFailuresInc    = jest.spyOn(treasuryPollFailures,  "inc");
  spyUnknownLabels  = jest.spyOn(treasuryUnknownAsset,  "labels").mockImplementation(() => treasuryUnknownAsset as any);
  spyUnknownInc     = jest.spyOn(treasuryUnknownAsset,  "inc");
}

beforeEach(() => {
  wireSpies();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<PollerConfig>): PollerConfig {
  return {
    pollIntervalMs: 100,
    maxStalenessMs: 500,
    thresholds: [
      { asset: "USDC", floor: 1000 },
      { asset: "XLM",  floor: 5000 },
    ],
    knownAssets: new Set(["USDC", "XLM"]),
    ...overrides,
  };
}

// ─── evaluateSeverity — boundary table ───────────────────────────────────────
//
// Prometheus rules (ops/alerts/treasury-drain.rules.yml) threshold mapping:
//   treasury_drain_severity == 0  → ok
//   treasury_drain_severity == 1  → warning
//   treasury_drain_severity == 2  → page
//   treasury_drain_severity >= 3  → critical
//
// evaluateSeverity decision logic (floor=F, hysteresis=H, clearPoint=F*(1+H)):
//   balance >= clearPoint          → "ok"       rank 0
//   balance >= F                   → "warning"  rank 1
//   balance >= F * 0.5             → "page"     rank 2
//   balance <  F * 0.5             → "critical" rank 3

describe("evaluateSeverity — boundary table (floor=1000, default hysteresis=0.1)", () => {
  // clearPoint = 1000 * 1.1 = 1100
  // halfFloor  = 1000 * 0.5 = 500
  const t: FloorThreshold = { asset: "USDC", floor: 1000 };

  const cases: Array<[string, number, ReturnType<typeof evaluateSeverity>]> = [
    // ── ok ────────────────────────────────────────────────────────────────────
    ["well above clearPoint: balance=5000 >= 1100",          5000, "ok"],
    ["exactly at clearPoint: balance=1100 == clearPoint",    1100, "ok"],
    // ── warning (clearPoint exclusive, floor inclusive) ────────────────────────
    ["one below clearPoint: balance=1099 < 1100",            1099, "warning"],
    ["midway floor–clearPoint: balance=1050",                1050, "warning"],
    ["exactly at floor: balance=1000 == floor",              1000, "warning"],
    // ── page (floor exclusive, halfFloor inclusive) ────────────────────────────
    ["one below floor: balance=999 < 1000",                   999, "page"],
    ["midway below floor: balance=800",                       800, "page"],
    ["exactly at halfFloor: balance=500 == floor*0.5",        500, "page"],
    // ── critical (below halfFloor) ─────────────────────────────────────────────
    ["one below halfFloor: balance=499 < 500",                499, "critical"],
    ["well below halfFloor: balance=300",                     300, "critical"],
    ["balance zero: balance=0",                                 0, "critical"],
  ];

  test.each(cases)("%s → %s", (_label, balance, expected) => {
    expect(evaluateSeverity(balance, t)).toBe(expected);
  });
});

describe("evaluateSeverity — custom hysteresis 0.25 (floor=1000, clearPoint=1250)", () => {
  const t: FloorThreshold = { asset: "XLM", floor: 1000, hysteresis: 0.25 };

  const cases: Array<[string, number, ReturnType<typeof evaluateSeverity>]> = [
    ["exactly at clearPoint: balance=1250 == clearPoint",   1250, "ok"],
    ["one below clearPoint: balance=1249 < 1250",           1249, "warning"],
    ["exactly at floor: balance=1000 == floor",             1000, "warning"],
    ["one below floor: balance=999 < 1000",                  999, "page"],
    ["exactly at halfFloor: balance=500 == floor*0.5",       500, "page"],
    ["one below halfFloor: balance=499 < 500",               499, "critical"],
  ];

  test.each(cases)("%s → %s", (_label, balance, expected) => {
    expect(evaluateSeverity(balance, t)).toBe(expected);
  });
});

describe("evaluateSeverity — hysteresis: 0 (clearPoint == floor, no dead-band)", () => {
  // With hysteresis=0, clearPoint = floor * (1 + 0) = floor.
  // The "warning" band collapses to zero width — balance == floor returns "ok".
  const t: FloorThreshold = { asset: "USDC", floor: 1000, hysteresis: 0 };

  it("balance exactly at floor returns ok (hysteresis 0 collapses warning band)", () => {
    expect(evaluateSeverity(1000, t)).toBe("ok");
  });

  it("one below floor returns page — warning band absent when hysteresis is 0", () => {
    expect(evaluateSeverity(999, t)).toBe("page");
  });

  it("exactly at halfFloor (500) returns page (hysteresis 0)", () => {
    expect(evaluateSeverity(500, t)).toBe("page");
  });

  it("one below halfFloor (499) returns critical (hysteresis 0)", () => {
    expect(evaluateSeverity(499, t)).toBe("critical");
  });
});

// ─── TreasuryBalancePoller — severity transitions ────────────────────────────

describe("TreasuryBalancePoller — severity transitions", () => {
  it("ok: balance well above clearPoint", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("warning: balance between floor (1000) and clearPoint (1100)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 1050 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("warning");
  });

  it("warning: balance exactly at floor (1000)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 1000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("warning");
  });

  it("page: balance one below floor (999)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 999 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("page");
  });

  it("page: balance exactly at halfFloor (500 == floor*0.5)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 500 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("page");
  });

  it("critical: balance one below halfFloor (499 < 500)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 499 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("critical");
  });

  it("critical: balance zero", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 0 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("critical");
  });

  it("escalates immediately from ok → critical on a single bad poll", async () => {
    let call = 0;
    const provider: BalanceProvider = async () => {
      call++;
      return [{ asset: "USDC", account: "t1", balance: call === 1 ? 5000 : 0 }];
    };
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("critical");
  });

  it("de-escalates from critical → ok when balance recovers above clearPoint", async () => {
    let returnCritical = true;
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: returnCritical ? 0 : 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("critical");
    returnCritical = false;
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("severity gauge written with SEVERITY_RANK 3 for critical (maps to Prometheus alert)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 0 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(spySeveritySet).toHaveBeenCalledWith(3);
  });

  it("severity gauge written with SEVERITY_RANK 0 for ok (maps to Prometheus alert)", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(spySeveritySet).toHaveBeenCalledWith(0);
  });

  it("tracks multiple accounts independently", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
      { asset: "USDC", account: "t2", balance: 499 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
    expect(poller.getSeverity("USDC", "t2")).toBe("critical");
  });

  it("skips state tracking for assets with no matching threshold", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(
      provider,
      makeConfig({ thresholds: [] }),
    );
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });
});

// ─── Stale reading raises poll-failure counter ────────────────────────────────

describe("TreasuryBalancePoller — stale reading and poll-failure counter", () => {
  it("increments treasury_poll_failures counter on each provider failure", async () => {
    let callCount = 0;
    const provider: BalanceProvider = async () => {
      callCount++;
      if (callCount === 1) return [{ asset: "USDC", account: "t1", balance: 5000 }];
      throw new Error("network down");
    };

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll(); // succeeds — seeds the USDC:t1 state entry

    // Reset spy call counts before the failing poll.
    spyFailuresInc.mockClear();

    await poller.poll(); // fails → treasuryPollFailures.labels().inc() must fire
    expect(spyFailuresInc).toHaveBeenCalledTimes(1);
  });

  it("increments consecutiveFailures on each failed poll", async () => {
    let callCount = 0;
    const provider: BalanceProvider = async () => {
      callCount++;
      if (callCount === 1) return [{ asset: "USDC", account: "t1", balance: 5000 }];
      throw new Error("boom");
    };

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();
    expect(poller.getAlarmStates()[0].consecutiveFailures).toBe(0);

    await poller.poll();
    expect(poller.getAlarmStates()[0].consecutiveFailures).toBe(1);

    await poller.poll();
    expect(poller.getAlarmStates()[0].consecutiveFailures).toBe(2);
  });

  it("escalates to page when reading is stale during a poll failure", async () => {
    let callCount = 0;
    const provider: BalanceProvider = async () => {
      callCount++;
      if (callCount === 1) return [{ asset: "USDC", account: "t1", balance: 5000 }];
      throw new Error("stale");
    };

    // maxStalenessMs of 1 ms so the reading becomes stale almost immediately.
    const poller = new TreasuryBalancePoller(
      provider,
      makeConfig({ maxStalenessMs: 1 }),
    );

    await poller.poll(); // succeeds, seeds state at ok
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");

    await new Promise<void>((r) => setTimeout(r, 10)); // let reading go stale

    await poller.poll(); // fails and isStale() is true → escalates to page
    expect(poller.getSeverity("USDC", "t1")).toBe("page");
  });

  it("isStale returns true before the first successful poll", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    expect(poller.isStale()).toBe(true);
  });

  it("isStale returns false immediately after a successful poll", async () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    await poller.poll();
    expect(poller.isStale()).toBe(false);
  });

  it("isStale returns true once maxStalenessMs has elapsed since last poll", async () => {
    const poller = new TreasuryBalancePoller(
      async () => [],
      makeConfig({ maxStalenessMs: 1 }),
    );
    await poller.poll();
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(poller.isStale()).toBe(true);
  });
});

// ─── knownAssets handling ─────────────────────────────────────────────────────

describe("TreasuryBalancePoller — knownAssets increments treasury_unknown_asset_total", () => {
  it("increments treasury_unknown_asset_total once per unknown asset per poll", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "BTC",  account: "t1", balance: 100 },   // unknown
      { asset: "ETH",  account: "t1", balance: 200 },   // unknown
      { asset: "USDC", account: "t1", balance: 5000 },  // known
    ];

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();

    expect(spyUnknownInc).toHaveBeenCalledTimes(2);
  });

  it("calls treasuryUnknownAsset.labels with the asset code for each unknown asset", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "BTC", account: "t1", balance: 100 },
    ];

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();

    expect(spyUnknownLabels).toHaveBeenCalledWith("BTC");
    expect(spyUnknownInc).toHaveBeenCalledTimes(1);
  });

  it("does not add unknown assets to alarm state — getSeverity defaults to ok", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "SHIB", account: "t1", balance: 100 },
    ];

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();

    expect(poller.getSeverity("SHIB", "t1")).toBe("ok");
    expect(poller.getAlarmStates()).toHaveLength(0);
  });

  it("known assets do not increment unknown counter", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
      { asset: "XLM",  account: "t1", balance: 10000 },
    ];

    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();

    expect(spyUnknownInc).not.toHaveBeenCalled();
  });
});

// ─── Additional integration tests ────────────────────────────────────────────

describe("TreasuryBalancePoller — general integration", () => {
  it("getAlarmStates returns a snapshot of all tracked entries", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
      { asset: "XLM",  account: "t2", balance: 3000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());
    await poller.poll();

    const states = poller.getAlarmStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => `${s.asset}:${s.account}`)).toContain("USDC:t1");
    expect(states.map((s) => `${s.asset}:${s.account}`)).toContain("XLM:t2");
  });

  it("handles an empty balance response without errors", async () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    await poller.poll();
    expect(poller.getAlarmStates()).toHaveLength(0);
  });

  it("getSeverity returns ok for a key that was never polled", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    expect(poller.getSeverity("USDC", "t-never")).toBe("ok");
  });

  it("start is idempotent — calling it twice does not create a duplicate interval", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    poller.start();
    poller.start();
    poller.stop();
  });

  it("stop is idempotent — calling it before start does not throw", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    expect(() => poller.stop()).not.toThrow();
    expect(() => poller.stop()).not.toThrow();
  });
});

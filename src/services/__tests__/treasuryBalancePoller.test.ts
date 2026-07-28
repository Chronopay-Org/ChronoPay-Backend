import {
  TreasuryBalancePoller,
  evaluateSeverity,
  type BalanceProvider,
  type FloorThreshold,
  type PollerConfig,
  type TreasuryBalanceEntry,
  type AlarmSeverity,
} from "../treasuryBalancePoller.js";

// ─── Unit tests for evaluateSeverity ────────────────────────────────────────

describe("evaluateSeverity", () => {
  const threshold: FloorThreshold = { asset: "USDC", floor: 1000 };

  it("returns ok when balance is well above floor", () => {
    expect(evaluateSeverity(5000, threshold)).toBe("ok");
  });

  it("returns ok when balance is exactly at clearPoint (floor * 1.1)", () => {
    expect(evaluateSeverity(1100, threshold)).toBe("ok");
  });

  it("returns warning when balance is between floor and clearPoint", () => {
    expect(evaluateSeverity(1050, threshold)).toBe("warning");
  });

  it("returns warning when balance is just below clearPoint", () => {
    expect(evaluateSeverity(1099, threshold)).toBe("warning");
  });

  it("returns page when balance is below floor but above 50%", () => {
    expect(evaluateSeverity(600, threshold)).toBe("page");
  });

  it("returns page when balance is just below floor", () => {
    expect(evaluateSeverity(999, threshold)).toBe("page");
  });

  it("returns critical when balance is below 50% of floor", () => {
    expect(evaluateSeverity(499, threshold)).toBe("critical");
  });

  it("returns critical when balance is zero", () => {
    expect(evaluateSeverity(0, threshold)).toBe("critical");
  });

  it("respects custom hysteresis", () => {
    const t: FloorThreshold = { asset: "XLM", floor: 1000, hysteresis: 0.25 };
    // clearPoint = 1000 * 1.25 = 1250
    expect(evaluateSeverity(1250, t)).toBe("ok");
    expect(evaluateSeverity(1249, t)).toBe("warning");
    expect(evaluateSeverity(1000, t)).toBe("warning");
    expect(evaluateSeverity(999, t)).toBe("page");
    expect(evaluateSeverity(500, t)).toBe("page");
    expect(evaluateSeverity(499, t)).toBe("critical");
  });

  it("zero hysteresis means ok only above floor", () => {
    const t: FloorThreshold = { asset: "USDC", floor: 1000, hysteresis: 0 };
    // clearPoint = 1000 * 1.0 = 1000
    expect(evaluateSeverity(1000, t)).toBe("ok");
    expect(evaluateSeverity(999, t)).toBe("page");
  });
});

// ─── TreasuryBalancePoller integration tests ────────────────────────────────

function makeConfig(overrides?: Partial<PollerConfig>): PollerConfig {
  return {
    pollIntervalMs: 100,
    maxStalenessMs: 500,
    thresholds: [
      { asset: "USDC", floor: 1000 },
      { asset: "XLM", floor: 5000 },
    ],
    knownAssets: new Set(["USDC", "XLM"]),
    ...overrides,
  };
}

describe("TreasuryBalancePoller", () => {
  it("evaluates ok severity for healthy balances", async () => {
    const balances: TreasuryBalanceEntry[] = [
      { asset: "USDC", account: "treasury-1", balance: 5000 },
      { asset: "XLM", account: "treasury-1", balance: 10000 },
    ];
    const provider: BalanceProvider = async () => balances;
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("USDC", "treasury-1")).toBe("ok");
    expect(poller.getSeverity("XLM", "treasury-1")).toBe("ok");
  });

  it("evaluates warning when balance approaches floor", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 1050 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("USDC", "t1")).toBe("warning");
  });

  it("evaluates page when balance is below floor", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 800 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("USDC", "t1")).toBe("page");
  });

  it("evaluates critical when balance is below 50% of floor", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 300 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("USDC", "t1")).toBe("critical");
  });

  it("tracks multiple accounts independently", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
      { asset: "USDC", account: "t2", balance: 800 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
    expect(poller.getSeverity("USDC", "t2")).toBe("page");
  });

  it("ignores unknown assets in treasury response", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "BTC", account: "t1", balance: 100 },
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    expect(poller.getSeverity("BTC", "t1")).toBe("ok"); // not tracked
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("skips assets without thresholds", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig({
      thresholds: [], // no thresholds configured
    }));

    await poller.poll();

    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("handles poll failure gracefully", async () => {
    let callCount = 0;
    const provider: BalanceProvider = async () => {
      callCount++;
      if (callCount === 1) {
        return [{ asset: "USDC", account: "t1", balance: 5000 }];
      }
      throw new Error("Network error");
    };
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");

    await poller.poll();
    // Severity doesn't drop on poll failure — stays at previous level
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("isStale returns true before first poll", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    expect(poller.isStale()).toBe(true);
  });

  it("isStale returns false after recent poll", async () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    await poller.poll();
    expect(poller.isStale()).toBe(false);
  });

  it("isStale returns true when poll exceeds maxStalenessMs", async () => {
    const poller = new TreasuryBalancePoller(
      async () => [],
      makeConfig({ maxStalenessMs: 1 }),
    );
    await poller.poll();

    // Wait for staleness
    await new Promise((r) => setTimeout(r, 10));

    expect(poller.isStale()).toBe(true);
  });

  it("getAlarmStates returns all tracked entries", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
      { asset: "XLM", account: "t2", balance: 3000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();

    const states = poller.getAlarmStates();
    expect(states).toHaveLength(2);
    expect(states.map((s) => `${s.asset}:${s.account}`)).toContain("USDC:t1");
    expect(states.map((s) => `${s.asset}:${s.account}`)).toContain("XLM:t2");
  });

  it("start and stop control the polling interval", async () => {
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig({ pollIntervalMs: 50 }));

    poller.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(poller.getAlarmStates().length).toBeGreaterThanOrEqual(1);

    poller.stop();
    // No more polls after stop
    const countAfterStop = poller.getAlarmStates().length;
    await new Promise((r) => setTimeout(r, 100));
    expect(poller.getAlarmStates().length).toBe(countAfterStop);
  });

  it("start is idempotent", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    poller.start();
    poller.start(); // Should not throw or create duplicate interval
    poller.stop();
  });

  it("stop is idempotent", () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    poller.stop();
    poller.stop(); // Should not throw
  });

  it("de-escalates severity when balance recovers", async () => {
    let returnCritical = true;
    const provider: BalanceProvider = async () => [
      { asset: "USDC", account: "t1", balance: returnCritical ? 300 : 5000 },
    ];
    const poller = new TreasuryBalancePoller(provider, makeConfig());

    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("critical");

    returnCritical = false;
    await poller.poll();
    expect(poller.getSeverity("USDC", "t1")).toBe("ok");
  });

  it("handles empty balance response", async () => {
    const poller = new TreasuryBalancePoller(async () => [], makeConfig());
    await poller.poll();
    expect(poller.getAlarmStates()).toHaveLength(0);
  });

  it("severity ranking is consistent", () => {
    expect(evaluateSeverity(9999, { asset: "USDC", floor: 1000 })).toBe("ok");
    expect(evaluateSeverity(0, { asset: "USDC", floor: 1000 })).toBe("critical");
  });
});

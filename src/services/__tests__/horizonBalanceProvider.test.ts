import { jest } from "@jest/globals";
import { EnvValidationError, loadEnvConfig } from "../../config/env.js";
import { register } from "../../metrics.js";
import {
  createHorizonBalanceProvider,
  decimalBalanceToStroops,
  type HorizonAccountBalancesResponse,
  type HorizonHostManagerLike,
} from "../horizonBalanceProvider.js";
import { TreasuryBalancePoller } from "../treasuryBalancePoller.js";

function createFakeHostManager(host = "https://horizon.example.test"): {
  manager: HorizonHostManagerLike;
  recordSuccess: jest.Mock;
  recordError: jest.Mock;
  getHealthyHost: jest.Mock<() => Promise<string>>;
} {
  const getHealthyHost = jest.fn<() => Promise<string>>().mockResolvedValue(host);
  const recordSuccess = jest.fn();
  const recordError = jest.fn();
  return {
    manager: { getHealthyHost, recordSuccess, recordError },
    getHealthyHost,
    recordSuccess,
    recordError,
  };
}

function makeFakeFetch(
  responses: Record<
    string,
    { status?: number; body?: HorizonAccountBalancesResponse; error?: Error }
  >,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const account = decodeURIComponent(url.split("/accounts/")[1] ?? "");
    const spec = responses[account];
    if (!spec) {
      return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    }
    if (spec.error) {
      throw spec.error;
    }
    const status = spec.status ?? 200;
    return new Response(JSON.stringify(spec.body ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("decimalBalanceToStroops", () => {
  it("converts whole and fractional Stellar balances accurately", () => {
    expect(decimalBalanceToStroops("0")).toBe(0);
    expect(decimalBalanceToStroops("0.0000001")).toBe(1);
    expect(decimalBalanceToStroops("1")).toBe(10_000_000);
    expect(decimalBalanceToStroops("100.5000000")).toBe(1_005_000_000);
    expect(decimalBalanceToStroops("1234.56")).toBe(12_345_600_000);
  });

  it("throws on malformed balance strings", () => {
    expect(() => decimalBalanceToStroops("-10.0")).toThrow(/Invalid Horizon balance/);
    expect(() => decimalBalanceToStroops("abc")).toThrow(/Invalid Horizon balance/);
    expect(() => decimalBalanceToStroops("1.12345678")).toThrow(/Invalid Horizon balance/);
  });
});

describe("createHorizonBalanceProvider", () => {
  it("fetches balances for multiple accounts and converts them to stroops", async () => {
    const { manager, recordSuccess } = createFakeHostManager();
    const fetchImpl = makeFakeFetch({
      GACC1: {
        body: {
          id: "GACC1",
          balances: [
            { asset_type: "native", balance: "150.0000000" },
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: "GISSUER",
              balance: "250.5000000",
            },
            { asset_type: "liquidity_pool_shares", balance: "10.0000000" },
          ],
        },
      },
      GACC2: {
        body: {
          id: "GACC2",
          balances: [{ asset_type: "native", balance: "42.1234567" }],
        },
      },
    });

    const provider = createHorizonBalanceProvider(["GACC1", "GACC2"], manager, { fetchImpl });
    const entries = await provider();

    expect(entries).toEqual([
      { account: "GACC1", asset: "XLM", balance: 1_500_000_000 },
      { account: "GACC1", asset: "USDC", balance: 2_505_000_000 },
      { account: "GACC2", asset: "XLM", balance: 421_234_567 },
    ]);
    expect(recordSuccess).toHaveBeenCalledTimes(2);
  });

  it("isolates per-account Horizon failures and increments treasury_poll_failures_total", async () => {
    const { manager, recordError, recordSuccess } = createFakeHostManager();
    const fetchImpl = makeFakeFetch({
      GFAIL: { status: 503 },
      GNETERR: { error: new Error("ECONNRESET") },
      GOK: {
        body: {
          id: "GOK",
          balances: [{ asset_type: "native", balance: "50.0000000" }],
        },
      },
    });

    const onAccountError = jest.fn();
    const provider = createHorizonBalanceProvider(["GFAIL", "GNETERR", "GOK"], manager, {
      fetchImpl,
      onAccountError,
    });

    const entries = await provider();

    expect(entries).toEqual([{ account: "GOK", asset: "XLM", balance: 500_000_000 }]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledTimes(2);
    expect(onAccountError).toHaveBeenCalledTimes(2);

    const metricsText = await register.metrics();
    expect(metricsText).toContain("treasury_poll_failures_total");
    expect(metricsText).toContain('asset_issuer="GFAIL"');
    expect(metricsText).toContain('asset_issuer="GNETERR"');
  });
});

describe("TreasuryBalancePoller with fake Horizon provider", () => {
  const FLOOR = 1_000_000_000; // 100 units in stroops

  it("evaluates ok, warning, page, critical, and unknown-asset paths", async () => {
    const { manager } = createFakeHostManager();
    const fetchImpl = makeFakeFetch({
      GOK_ACC: {
        body: {
          balances: [
            // 120 units >= 110 (clearPoint) => ok (0)
            { asset_type: "native", balance: "120.0000000" },
            // unknown asset => treasury_unknown_asset_total
            { asset_type: "credit_alphanum4", asset_code: "MYSTERY", balance: "5.0000000" },
          ],
        },
      },
      GWARN_ACC: {
        body: {
          balances: [
            // 105 units in [100, 110) => warning (1)
            { asset_type: "native", balance: "105.0000000" },
          ],
        },
      },
      GPAGE_ACC: {
        body: {
          balances: [
            // 75 units in [50, 100) => page (2)
            { asset_type: "native", balance: "75.0000000" },
          ],
        },
      },
      GCRIT_ACC: {
        body: {
          balances: [
            // 20 units < 50 => critical (3)
            { asset_type: "native", balance: "20.0000000" },
          ],
        },
      },
    });

    const provider = createHorizonBalanceProvider(
      ["GOK_ACC", "GWARN_ACC", "GPAGE_ACC", "GCRIT_ACC"],
      manager,
      { fetchImpl },
    );

    const poller = new TreasuryBalancePoller(provider, {
      pollIntervalMs: 1_000,
      maxStalenessMs: 5_000,
      thresholds: [{ asset: "XLM", floor: FLOOR, hysteresis: 0.1 }],
      knownAssets: new Set(["XLM", "USDC"]),
    });

    await poller.poll();

    expect(poller.getSeverity("XLM", "GOK_ACC")).toBe("ok");
    expect(poller.getSeverity("XLM", "GWARN_ACC")).toBe("warning");
    expect(poller.getSeverity("XLM", "GPAGE_ACC")).toBe("page");
    expect(poller.getSeverity("XLM", "GCRIT_ACC")).toBe("critical");

    const metricsText = await register.metrics();
    expect(metricsText).toContain('treasury_drain_severity{asset_code="XLM",asset_issuer="GOK_ACC"} 0');
    expect(metricsText).toContain('treasury_drain_severity{asset_code="XLM",asset_issuer="GWARN_ACC"} 1');
    expect(metricsText).toContain('treasury_drain_severity{asset_code="XLM",asset_issuer="GPAGE_ACC"} 2');
    expect(metricsText).toContain('treasury_drain_severity{asset_code="XLM",asset_issuer="GCRIT_ACC"} 3');
    expect(metricsText).toContain('treasury_unknown_asset_total{asset_code="MYSTERY"}');
  });
});

describe("Treasury env configuration parsing", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    REDIS_URL: "redis://localhost:6379",
  };

  it("parses defaults when treasury env vars are omitted", () => {
    const config = loadEnvConfig(baseEnv);
    expect(config.treasuryAccounts).toEqual([]);
    expect(config.treasuryFloors).toEqual([]);
    expect(config.treasuryPollIntervalMs).toBe(30_000);
    expect(config.treasuryMaxStalenessMs).toBe(120_000);
  });

  it("parses TREASURY_ACCOUNTS, array TREASURY_FLOORS_JSON, and intervals", () => {
    const config = loadEnvConfig({
      ...baseEnv,
      TREASURY_ACCOUNTS: "GACC1, GACC2",
      TREASURY_FLOORS_JSON: JSON.stringify([
        { asset: "XLM", floor: 10_000_000, hysteresis: 0.15 },
        { asset: "USDC", floor: 50_000_000 },
      ]),
      TREASURY_POLL_INTERVAL_MS: "15000",
      TREASURY_MAX_STALENESS_MS: "60000",
    });

    expect(config.treasuryAccounts).toEqual(["GACC1", "GACC2"]);
    expect(config.treasuryFloors).toEqual([
      { asset: "XLM", floor: 10_000_000, hysteresis: 0.15 },
      { asset: "USDC", floor: 50_000_000 },
    ]);
    expect(config.treasuryPollIntervalMs).toBe(15_000);
    expect(config.treasuryMaxStalenessMs).toBe(60_000);
  });

  it("parses object-map TREASURY_FLOORS_JSON", () => {
    const config = loadEnvConfig({
      ...baseEnv,
      TREASURY_FLOORS_JSON: JSON.stringify({
        XLM: 10_000_000,
        USDC: { floor: 50_000_000, hysteresis: 0.2 },
      }),
    });

    expect(config.treasuryFloors).toEqual([
      { asset: "XLM", floor: 10_000_000 },
      { asset: "USDC", floor: 50_000_000, hysteresis: 0.2 },
    ]);
  });

  it("fails fast with EnvValidationError on malformed TREASURY_FLOORS_JSON", () => {
    expect(() =>
      loadEnvConfig({
        ...baseEnv,
        TREASURY_FLOORS_JSON: "{not-valid-json",
      }),
    ).toThrow(EnvValidationError);

    try {
      loadEnvConfig({
        ...baseEnv,
        TREASURY_FLOORS_JSON: JSON.stringify([{ asset: "", floor: -5, hysteresis: 2 }]),
      });
      throw new Error("Expected loadEnvConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const validationErr = err as EnvValidationError;
      expect(validationErr.message).toContain("TREASURY_FLOORS_JSON");
    }
  });
});

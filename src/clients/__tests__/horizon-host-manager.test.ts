import { jest } from "@jest/globals";

import { HorizonHostManager } from "../horizon-host-manager.js";
import { HorizonUnavailableError } from "../../errors/contractErrors.js";
import { AppError } from "../../errors/AppError.js";
import {
  horizonHostHealth,
  horizonFailoverTotal,
  _resetMetricCardinalityState,
} from "../../metrics.js";

/**
 * Regression coverage for HorizonHostManager failure handling (#1019).
 *
 * The failure branch under test is the constructor guard in
 * `src/clients/horizon-host-manager.ts`:
 *
 *   throw new Error("HorizonHostManager requires at least one URL");
 *
 * plus the neighboring normal path (primary selected, fallback failover,
 * recovery probes) and the boundary inputs that drive them (quarantine
 * cooldown, sliding error window, error classification).
 *
 * Determinism: `Date.now` and `global.fetch` are mocked. No fake timers are
 * used so the `AbortController` bookkeeping inside `probeHost` stays safe.
 */

// ─── Time / clock helpers ─────────────────────────────────────────────────────

const BASE_TIME = 1_000_000_000; // fixed epoch ms for every test
const QUARANTINE_COOLDOWN_MS = 15000; // mirrors HorizonHostManager internals
const ERROR_WINDOW_MS = 10000; // mirrors HorizonHostManager internals

const realDateNow = Date.now.bind(Date);
const realFetch = globalThis.fetch;

/** Advance the mocked clock to `BASE_TIME + ms`. */
function advanceTime(ms: number): void {
  Date.now = jest.fn(() => BASE_TIME + ms) as unknown as typeof Date.now;
}

afterAll(() => {
  Date.now = realDateNow;
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
});

// ─── Metric helpers (real prom-client registry) ───────────────────────────────

async function healthFor(url: string): Promise<number | undefined> {
  const { values } = await horizonHostHealth.get();
  return values.find((v) => v.labels.url === url)?.value;
}

async function failoverCount(): Promise<number> {
  const { values } = await horizonFailoverTotal.get();
  return values[0]?.value ?? 0;
}

async function resetMetrics(): Promise<void> {
  horizonHostHealth.reset();
  horizonFailoverTotal.reset();
  _resetMetricCardinalityState();
}

// ─── Error-classification helpers ─────────────────────────────────────────────
// `recordError` only quarantines for retriable failures (see
// `shouldRetryContractError` in src/errors/contractErrors.ts).
//
// In production the manager is fed `HorizonHttpError` instances from
// horizon-contract-client.ts, whose messages are built by
// `HorizonHttpError.buildMessage`:
//   5xx → "service unavailable: Horizon HTTP <status>: <detail>"
//   429 → "rate limit exceeded: Horizon HTTP <status>: <detail>"
//   4xx → "invalid argument: Horizon HTTP <status>: <detail>"
// The fixtures below mirror those exact message shapes so the classification
// exercised here matches what the manager sees at runtime.

/** A retriable 5xx-shaped failure (mirrors `HorizonHttpError(503, "")`). */
const retriableError = (): Error => new Error("service unavailable: Horizon HTTP 503: ");

const retriableErrors = (): Array<{ name: string; error: unknown }> => [
  {
    name: "5xx HorizonHttpError shape (service unavailable)",
    error: retriableError(),
  },
  {
    name: "429 HorizonHttpError shape (rate limit)",
    error: new Error("rate limit exceeded: Horizon HTTP 429: "),
  },
  {
    name: "ethers NETWORK_ERROR code",
    error: Object.assign(new Error("request failed"), { code: "NETWORK_ERROR" }),
  },
  {
    name: "ethers TIMEOUT code",
    error: Object.assign(new Error("oops"), { code: "TIMEOUT" }),
  },
];

const nonRetriableErrors = (): Array<{ name: string; error: unknown }> => [
  {
    name: "4xx HorizonHttpError shape (invalid argument)",
    error: new Error("invalid argument: Horizon HTTP 400: "),
  },
  { name: "plain Error", error: new Error("something went wrong") },
];

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const PRIMARY = "http://primary";
const FALLBACK = "http://fallback";

/** Quarantine a host: MAX_ERRORS (3) retriable errors at the current time. */
function quarantineHost(
  manager: HorizonHostManager,
  url: string,
  error: unknown = retriableError(),
): void {
  manager.recordError(url, error);
  manager.recordError(url, error);
  manager.recordError(url, error);
}

describe("HorizonHostManager", () => {
  let fetchMock: jest.Mock<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<{ ok: boolean }>
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    Date.now = jest.fn(() => BASE_TIME) as unknown as typeof Date.now;
    fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    fetchMock.mockResolvedValue({ ok: true });
    return resetMetrics();
  });

  // ── Constructor: the empty/invalid-URL failure branch (#1019 evidence) ──────

  describe("constructor — URL validation contract", () => {
    it("throws for an empty URL list", () => {
      expect(() => new HorizonHostManager([])).toThrow(
        "HorizonHostManager requires at least one URL",
      );
    });

    it("throws a plain Error (not an AppError) for an empty URL list", () => {
      let caught: unknown;
      try {
        new HorizonHostManager([]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(AppError);
    });

    it("throws for a null URL list", () => {
      expect(() => new HorizonHostManager(null as unknown as string[])).toThrow(
        "HorizonHostManager requires at least one URL",
      );
    });

    it("accepts a single URL (boundary: minimum valid input)", async () => {
      const manager = new HorizonHostManager([PRIMARY]);
      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
    });

    // Documents current behavior: only an empty list is rejected. If a
    // whitelist of well-formed URLs is ever introduced, this test should be
    // updated deliberately as part of a compatibility plan.
    it("accepts whitespace-only entries (documents current lax validation)", async () => {
      const manager = new HorizonHostManager(["   "]);
      await expect(manager.getHealthyHost()).resolves.toBe("   ");
    });

    it("strips a single trailing slash from host URLs (observable via getHealthyHost)", async () => {
      const manager = new HorizonHostManager(["http://primary/"]);
      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
    });
  });

  // ── getHealthyHost: normal path ─────────────────────────────────────────────

  describe("getHealthyHost — normal path", () => {
    it("returns the primary host when nothing is quarantined", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
    });

    it("never probes while no host is quarantined", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      await manager.getHealthyHost();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("registers healthy hosts (1) in the horizon_host_health gauge on construction", async () => {
      new HorizonHostManager([PRIMARY, FALLBACK]);
      await expect(healthFor(PRIMARY)).resolves.toBe(1);
      await expect(healthFor(FALLBACK)).resolves.toBe(1);
    });
  });

  // ── getHealthyHost: failover (neighboring failure path) ─────────────────────

  describe("getHealthyHost — failover when primary is quarantined", () => {
    it("fails over to the first healthy fallback after MAX_ERRORS retriable errors", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);

      quarantineHost(manager, PRIMARY);

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      await expect(healthFor(PRIMARY)).resolves.toBe(0);
      await expect(healthFor(FALLBACK)).resolves.toBe(1);
    });

    it("increments horizon_failover_total exactly once for consecutive failovers", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      await manager.getHealthyHost();
      await expect(failoverCount()).resolves.toBe(1);

      // Still failing over to the same fallback: no additional increment.
      await manager.getHealthyHost();
      await expect(failoverCount()).resolves.toBe(1);
    });

    it("does not count a failover when the primary is healthy again", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);

      await manager.getHealthyHost();
      await expect(failoverCount()).resolves.toBe(0);
    });

    it("fails over to the second fallback when both the primary and first fallback are quarantined", async () => {
      const manager = new HorizonHostManager([PRIMARY, "http://fallback-1", "http://fallback-2"]);

      quarantineHost(manager, PRIMARY);
      quarantineHost(manager, "http://fallback-1");

      await expect(manager.getHealthyHost()).resolves.toBe("http://fallback-2");
      await expect(healthFor("http://fallback-1")).resolves.toBe(0);
    });
  });

  // ── Quarantine cooldown boundary (deterministic clock) ──────────────────────

  describe("quarantine cooldown boundary", () => {
    it("does not probe while the host is inside the cooldown window", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      advanceTime(QUARANTINE_COOLDOWN_MS - 1); // 14999 ms: still cooling down

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("probes the quarantined host once the cooldown has elapsed", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      advanceTime(QUARANTINE_COOLDOWN_MS); // exactly the boundary

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY); // probe succeeded
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`${PRIMARY}/ledgers?limit=1`, {
        signal: expect.any(AbortSignal),
      });
    });
  });

  // ── Recovery probes ─────────────────────────────────────────────────────────

  describe("recovery probes", () => {
    it("restores a recovered primary with sticky selection and clears the health gauge", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      await manager.getHealthyHost(); // failover to fallback
      await expect(failoverCount()).resolves.toBe(1);

      advanceTime(QUARANTINE_COOLDOWN_MS);
      fetchMock.mockResolvedValue({ ok: true });

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY); // sticky recovery
      await expect(healthFor(PRIMARY)).resolves.toBe(1);
      await expect(failoverCount()).resolves.toBe(1); // recovery is not a failover

      // Primary stays selected afterwards without re-probing.
      fetchMock.mockClear();
      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the host quarantined and resets the cooldown when the probe fails", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      advanceTime(QUARANTINE_COOLDOWN_MS);
      fetchMock.mockResolvedValue({ ok: false });

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      await expect(healthFor(PRIMARY)).resolves.toBe(0);

      // A failed probe resets quarantinedAt: no second probe inside the new window.
      advanceTime(2 * QUARANTINE_COOLDOWN_MS - 1);
      fetchMock.mockClear();
      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      expect(fetchMock).not.toHaveBeenCalled();

      // Exactly one new probe at the next boundary.
      advanceTime(2 * QUARANTINE_COOLDOWN_MS);
      await manager.getHealthyHost();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats a rejected probe request as an unreachable host", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      advanceTime(QUARANTINE_COOLDOWN_MS);
      fetchMock.mockRejectedValue(new Error("connection refused"));

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      await expect(healthFor(PRIMARY)).resolves.toBe(0);
    });

    it("throws HorizonUnavailableError when the only host never recovers", async () => {
      const manager = new HorizonHostManager([PRIMARY]);
      quarantineHost(manager, PRIMARY);

      await expect(manager.getHealthyHost()).rejects.toThrow(HorizonUnavailableError);

      advanceTime(QUARANTINE_COOLDOWN_MS);
      fetchMock.mockResolvedValue({ ok: false });

      await expect(manager.getHealthyHost()).rejects.toThrow(HorizonUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1); // probed once per cooldown window
    });

    it("throws HorizonUnavailableError when every host is quarantined and probes fail", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);
      quarantineHost(manager, FALLBACK);

      await expect(manager.getHealthyHost()).rejects.toThrow(HorizonUnavailableError);

      advanceTime(QUARANTINE_COOLDOWN_MS);
      fetchMock.mockResolvedValue({ ok: false });

      await expect(manager.getHealthyHost()).rejects.toThrow(HorizonUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(2); // one probe per host
    });

    it("surfaces the HorizonUnavailableError contract (503 / HORIZON_UNAVAILABLE / operational)", async () => {
      const manager = new HorizonHostManager([PRIMARY]);
      quarantineHost(manager, PRIMARY);

      const error = await manager.getHealthyHost().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HorizonUnavailableError);
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe("HORIZON_UNAVAILABLE");
      expect(appError.statusCode).toBe(503);
      expect(appError.isOperational).toBe(true);
    });
  });

  // ── recordError: classification and boundary inputs ─────────────────────────

  describe("recordError — error classification", () => {
    it.each(retriableErrors())(
      "quarantines after MAX_ERRORS for retriable errors: $name",
      async ({ error }) => {
        const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
        quarantineHost(manager, PRIMARY, error);

        await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      },
    );

    it.each(nonRetriableErrors())(
      "does not quarantine for non-retriable errors: $name",
      async ({ error }) => {
        const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
        quarantineHost(manager, PRIMARY, error);

        await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(failoverCount()).resolves.toBe(0);
      },
    );

    it("ignores errors recorded for unknown URLs (boundary input)", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);

      for (let i = 0; i < 10; i++) {
        manager.recordError("http://not-a-known-host", retriableError());
      }

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
      await expect(healthFor(PRIMARY)).resolves.toBe(1);
    });

    it("ignores errors reported for an already quarantined host (still recovers)", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      advanceTime(ERROR_WINDOW_MS * 2); // now = BASE + 20000
      // Extra errors while quarantined are dropped entirely (early return).
      manager.recordError(PRIMARY, retriableError());
      manager.recordError(PRIMARY, retriableError());

      advanceTime(ERROR_WINDOW_MS * 2 + QUARANTINE_COOLDOWN_MS); // now = BASE + 35000
      // The recovery probe fires and succeeds, proving no unexpected
      // re-quarantine happened and recovery behavior is unaffected by the
      // extra error reports.
      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
    });

    it("ignores errors whose timestamps left the ERROR_WINDOW (sliding-window boundary)", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);

      // Three errors spaced wider than ERROR_WINDOW_MS never accumulate.
      advanceTime(0);
      manager.recordError(PRIMARY, retriableError());
      advanceTime(ERROR_WINDOW_MS + 2000);
      manager.recordError(PRIMARY, retriableError());
      advanceTime(2 * (ERROR_WINDOW_MS + 2000));

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("quarantines when three errors land inside the ERROR_WINDOW", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);

      advanceTime(0);
      manager.recordError(PRIMARY, retriableError());
      advanceTime(4000);
      manager.recordError(PRIMARY, retriableError());
      advanceTime(8000); // all three still within the 10 s window
      manager.recordError(PRIMARY, retriableError());

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
    });
  });

  // ── recordSuccess contract ──────────────────────────────────────────────────

  describe("recordSuccess", () => {
    it("un-quarantines a host immediately without waiting for a probe", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      await manager.getHealthyHost(); // failover
      manager.recordSuccess(PRIMARY);

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
      expect(fetchMock).not.toHaveBeenCalled(); // no probe needed
      await expect(healthFor(PRIMARY)).resolves.toBe(1);
    });

    it("is a no-op for unknown URLs", async () => {
      const manager = new HorizonHostManager([PRIMARY, FALLBACK]);
      quarantineHost(manager, PRIMARY);

      manager.recordSuccess("http://not-a-known-host");

      await expect(manager.getHealthyHost()).resolves.toBe(FALLBACK);
      await expect(healthFor(PRIMARY)).resolves.toBe(0);
    });

    it("keeps a healthy host healthy", async () => {
      const manager = new HorizonHostManager([PRIMARY]);

      manager.recordSuccess(PRIMARY);

      await expect(manager.getHealthyHost()).resolves.toBe(PRIMARY);
      await expect(healthFor(PRIMARY)).resolves.toBe(1);
    });
  });
});

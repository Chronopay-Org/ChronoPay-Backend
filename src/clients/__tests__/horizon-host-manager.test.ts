import { jest } from "@jest/globals";
import { HorizonHostManager } from "../horizon-host-manager.js";
import { HorizonUnavailableError } from "../../errors/contractErrors.js";

describe("HorizonHostManager", () => {
  let fetchMock: jest.Mock<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<{ ok: boolean }>
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn<typeof fetch>();
    Date.now = jest.fn(() => 1000000000); // stable time
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

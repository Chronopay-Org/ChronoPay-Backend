import { jest } from "@jest/globals";

// ─── Build an in-memory gauge store so tests can read back set values ─────────
type GaugeStore = Record<string, number>;
const gaugeStore: GaugeStore = {};

function makeGaugeMock(name: string) {
  return {
    labels: (host: string) => ({
      set: (value: number) => {
        gaugeStore[`${name}:${host}`] = value;
      },
      get: () => gaugeStore[`${name}:${host}`] ?? 0,
    }),
  };
}

// Stub createBudgetedGauge so the module under test does not touch prom-client
jest.unstable_mockModule("../../metrics.js", () => ({
  createBudgetedGauge: ({ name }: { name: string }) => makeGaugeMock(name),
}));

// Import AFTER mocking
const { horizonRateLimitRemaining, horizonRequestQueueDepth, recordRateLimitRemaining, recordQueueDepth, resetHorizonMetricsForHost } =
  await import("../../metrics/horizonMetrics.js");

const HOST = "https://horizon-testnet.stellar.org";

// ─────────────────────────────────────────────────────────────────────────────
// Helper that reads current gauge value via the mock store
function getRateLimitRemaining(host: string): number {
  return gaugeStore[`horizon_rate_limit_remaining:${host}`] ?? 0;
}
function getQueueDepth(host: string): number {
  return gaugeStore[`horizon_request_queue_depth:${host}`] ?? 0;
}

describe("horizonMetrics", () => {
  beforeEach(() => {
    // Clear the store before each test for isolation
    Object.keys(gaugeStore).forEach((k) => delete gaugeStore[k]);
  });

  describe("recordRateLimitRemaining", () => {
    it("sets the gauge for a known host", () => {
      recordRateLimitRemaining(HOST, 42);
      expect(getRateLimitRemaining(HOST)).toBe(42);
    });

    it("sets gauge to zero without throwing", () => {
      recordRateLimitRemaining(HOST, 0);
      expect(getRateLimitRemaining(HOST)).toBe(0);
    });

    it("ignores negative values (does not update the gauge)", () => {
      recordRateLimitRemaining(HOST, 10);
      recordRateLimitRemaining(HOST, -1);
      // Still at 10 because -1 was rejected
      expect(getRateLimitRemaining(HOST)).toBe(10);
    });

    it("ignores NaN values without throwing", () => {
      expect(() => recordRateLimitRemaining(HOST, NaN)).not.toThrow();
    });

    it("ignores empty host string without throwing", () => {
      expect(() => recordRateLimitRemaining("", 10)).not.toThrow();
    });

    it("handles very large remaining values", () => {
      recordRateLimitRemaining(HOST, Number.MAX_SAFE_INTEGER);
      expect(getRateLimitRemaining(HOST)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("sets gauge independently for multiple hosts", () => {
      const HOST2 = "https://horizon.stellar.org";
      recordRateLimitRemaining(HOST, 100);
      recordRateLimitRemaining(HOST2, 200);
      expect(getRateLimitRemaining(HOST)).toBe(100);
      expect(getRateLimitRemaining(HOST2)).toBe(200);
    });
  });

  describe("recordQueueDepth", () => {
    it("sets the queue depth gauge", () => {
      recordQueueDepth(HOST, 5);
      expect(getQueueDepth(HOST)).toBe(5);
    });

    it("sets queue depth to zero", () => {
      recordQueueDepth(HOST, 0);
      expect(getQueueDepth(HOST)).toBe(0);
    });

    it("ignores negative depth without throwing", () => {
      recordQueueDepth(HOST, 3);
      recordQueueDepth(HOST, -1);
      expect(getQueueDepth(HOST)).toBe(3);
    });

    it("ignores NaN without throwing", () => {
      expect(() => recordQueueDepth(HOST, NaN)).not.toThrow();
    });

    it("ignores empty host without throwing", () => {
      expect(() => recordQueueDepth("", 5)).not.toThrow();
    });
  });

  describe("resetHorizonMetricsForHost", () => {
    it("resets both gauges to zero for the given host", () => {
      recordRateLimitRemaining(HOST, 99);
      recordQueueDepth(HOST, 7);
      resetHorizonMetricsForHost(HOST);
      expect(getRateLimitRemaining(HOST)).toBe(0);
      expect(getQueueDepth(HOST)).toBe(0);
    });

    it("does not affect metrics for other hosts", () => {
      const OTHER = "https://other.stellar.org";
      recordRateLimitRemaining(OTHER, 50);
      recordQueueDepth(OTHER, 3);
      resetHorizonMetricsForHost(HOST);
      expect(getRateLimitRemaining(OTHER)).toBe(50);
      expect(getQueueDepth(OTHER)).toBe(3);
    });
  });
});

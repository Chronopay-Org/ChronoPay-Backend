import { RouteMetrics, WINDOWS_MS, recordRouteTraffic, resetSloMetrics } from "../metrics/sloMetrics.js";

describe("sloMetrics", () => {
  beforeEach(() => {
    resetSloMetrics();
  });

  it("should return 0 burn rate when there is no traffic", () => {
    const rm = new RouteMetrics("booking_intent");
    expect(rm.getBurnRate("5m")).toBe(0);
  });

  it("should calculate burn rate accurately during a single fast burn", () => {
    const rm = new RouteMetrics("booking_intent");
    const now = 10000000;
    
    // Total 100 requests in 5 mins
    // Error budget = 0.001 (for booking_intent)
    // 5 errors = 5% error rate
    // Burn rate = 0.05 / 0.001 = 50
    for (let i = 0; i < 95; i++) {
      rm.record(false, now);
    }
    for (let i = 0; i < 5; i++) {
      rm.record(true, now);
    }

    const burnRate5m = rm.getBurnRate("5m", now);
    expect(burnRate5m).toBeCloseTo(50);
  });

  it("should correctly handle both windows in breach", () => {
    const rm = new RouteMetrics("booking_intent");
    const baseTime = 100000000;
    
    // Simulate 1h of steady traffic
    for (let i = 0; i < 60; i++) {
      const time = baseTime - (i * 60 * 1000); // 1 request per min
      // 1 out of 10 is an error (10% error rate overall) -> high burn
      rm.record(i % 10 === 0, time);
    }

    // Now check at baseTime + 1 min
    const now = baseTime + 60 * 1000;
    const burn5m = rm.getBurnRate("5m", now);
    const burn1h = rm.getBurnRate("1h", now);

    // 10% error rate / 0.001 budget = 100 burn rate
    // Both windows should be well above the threshold
    expect(burn5m).toBeGreaterThan(14.4);
    expect(burn1h).toBeGreaterThan(14.4);
  });
});

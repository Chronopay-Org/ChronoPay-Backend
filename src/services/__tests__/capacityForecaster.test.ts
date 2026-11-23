import { capacityForecaster } from "../capacityForecaster.js";

describe("CapacityForecaster", () => {
  it("should handle empty or undefined history gracefully", () => {
    const resultEmpty = capacityForecaster.forecast([]);
    expect(resultEmpty.forecast).toHaveLength(8);
    expect(resultEmpty.forecast.every(v => v === 0)).toBe(true);
    expect(resultEmpty.backtestError).toBe(0);

    const resultUndef = capacityForecaster.forecast(undefined as any);
    expect(resultUndef.forecast).toHaveLength(8);
    expect(resultUndef.forecast.every(v => v === 0)).toBe(true);
    expect(resultUndef.backtestError).toBe(0);
  });

  it("should handle tenant onboarded midway", () => {
    // 0s for first 2 weeks, then data
    const history = [0, 0, 100, 110, 120];
    const onboardWeek = 2; // Data starts at index 2
    const result = capacityForecaster.forecast(history, onboardWeek);
    
    // relevant history: [100, 110, 120] -> avg = 110
    // Backtest Error = (|100-110| + |110-110| + |120-110|) / 3 = (10 + 0 + 10) / 3 = 6.666...
    expect(result.backtestError).toBeCloseTo(6.6666, 3);
    
    // Forecast 8 weeks
    expect(result.forecast).toHaveLength(8);
    // Base is 110
    // i=0: 110 * 1.1 = 121
    // i=1: 110
    // i=2: 110 * 0.9 = 99
    // i=3: 110
    expect(result.forecast[0]).toBe(121);
    expect(result.forecast[1]).toBe(110);
    expect(result.forecast[2]).toBe(99);
    expect(result.forecast[3]).toBe(110);
    expect(result.forecast[4]).toBe(121);
    expect(result.forecast[5]).toBe(110);
    expect(result.forecast[6]).toBe(99);
    expect(result.forecast[7]).toBe(110);
  });

  it("should handle sparse history with negative or invalid values gracefully", () => {
    const history = [100, -50, 120]; // -50 is ignored
    const result = capacityForecaster.forecast(history);
    
    // valid: 100, 120 -> avg = 110
    expect(result.backtestError).toBeCloseTo(10, 3);
    expect(result.forecast[1]).toBe(110);
  });

  it("should handle zero valid weeks edge case after slice", () => {
    const history = [100, 100];
    const result = capacityForecaster.forecast(history, 5); // onboard week > length
    
    expect(result.forecast.every(v => v === 0)).toBe(true);
    expect(result.backtestError).toBe(0);
  });

  it("should handle all negative/ignored values", () => {
    const history = [-10, -20];
    const result = capacityForecaster.forecast(history);
    expect(result.forecast.every(v => v === 0)).toBe(true);
    expect(result.backtestError).toBe(0);
  });
});

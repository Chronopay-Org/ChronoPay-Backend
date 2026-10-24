import { jest } from "@jest/globals";
import { ReminderAutoscaler } from "../scheduler/reminderAutoscaler.js";
import { defaultAutoscaleConfig } from "../scheduler/reminderConfig.js";
import { reminderMetrics } from "../scheduler/reminderMetrics.js";
import { InMemoryReminderRepository } from "../models/reminder.js";
import { runReminderWorker } from "../scheduler/reminderWorker.js";

describe("ReminderAutoscaler", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    reminderMetrics.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("initial state", () => {
    it("starts at minConcurrency", () => {
      const autoscaler = new ReminderAutoscaler();
      expect(autoscaler.getCurrentConcurrency()).toBe(defaultAutoscaleConfig.minConcurrency);
    });

    it("honors custom min/max bounds", () => {
      const autoscaler = new ReminderAutoscaler({ minConcurrency: 2, maxConcurrency: 5 });
      expect(autoscaler.getCurrentConcurrency()).toBe(2);
    });
  });

  describe("scale-up behavior", () => {
    it("scales up when backlog per worker exceeds threshold", () => {
      const autoscaler = new ReminderAutoscaler({
        scaleUpThreshold: 20,
        scaleUpCooldownMs: 0,
      });
      // backlog 25 with 1 worker → perWorker 25 > 20 → scale up
      expect(autoscaler.update(25)).toBe(2);
    });

    it("does not scale up when backlog per worker is below threshold", () => {
      const autoscaler = new ReminderAutoscaler({
        scaleUpThreshold: 20,
        scaleUpCooldownMs: 0,
      });
      expect(autoscaler.update(10)).toBe(1);
    });

    it("respects scale-up cooldown", () => {
      const autoscaler = new ReminderAutoscaler({
        scaleUpThreshold: 20,
        scaleUpCooldownMs: 30_000,
      });
      expect(autoscaler.update(25)).toBe(2); // scale up at t=0

      // Immediately after, still above threshold but within cooldown
      expect(autoscaler.update(50)).toBe(2);

      // Advance past cooldown
      jest.advanceTimersByTime(30_001);
      expect(autoscaler.update(50)).toBe(3);
    });

    it("never exceeds maxConcurrency even under extreme backlog", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 4,
        scaleUpThreshold: 1,
        scaleUpCooldownMs: 0,
      });

      // Repeatedly feed huge backlog; concurrency must cap at 4
      for (let i = 0; i < 100; i++) {
        autoscaler.update(10_000);
      }
      expect(autoscaler.getCurrentConcurrency()).toBe(4);
    });

    it("scales up incrementally (one step per update)", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 8,
        scaleUpThreshold: 1,
        scaleUpCooldownMs: 0,
      });

      expect(autoscaler.update(100)).toBe(2);
      expect(autoscaler.update(100)).toBe(3);
      expect(autoscaler.update(100)).toBe(4);
    });
  });

  describe("scale-down behavior", () => {
    it("scales down when backlog per worker drops below threshold", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 4,
        scaleUpThreshold: 1,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      });

      // Scale up to 4
      for (let i = 0; i < 10; i++) {
        autoscaler.update(100);
      }
      expect(autoscaler.getCurrentConcurrency()).toBe(4);

      // Now backlog drops to 0 → perWorker 0 < 5 → scale down
      expect(autoscaler.update(0)).toBe(3);
    });

    it("does not scale below minConcurrency", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 2,
        maxConcurrency: 4,
        scaleUpThreshold: 1,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      });

      // Feed idle backlog repeatedly; must never go below 2
      for (let i = 0; i < 100; i++) {
        autoscaler.update(0);
      }
      expect(autoscaler.getCurrentConcurrency()).toBe(2);
    });

    it("respects scale-down cooldown (hysteresis)", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 4,
        scaleUpThreshold: 1,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 60_000,
      });

      // Scale up to 2
      autoscaler.update(100);
      expect(autoscaler.getCurrentConcurrency()).toBe(2);

      // Backlog drops; scale down once
      expect(autoscaler.update(0)).toBe(1);

      // Within cooldown, no further scale-down
      expect(autoscaler.update(0)).toBe(1);

      // Advance past cooldown; still at min so no change
      jest.advanceTimersByTime(60_001);
      expect(autoscaler.update(0)).toBe(1);
    });
  });

  describe("hysteresis / steady-state", () => {
    it("does not flap when backlog hovers between thresholds", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 4,
        scaleUpThreshold: 20,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      });

      // Backlog 10 with 1 worker → perWorker 10, between 5 and 20 → no change
      expect(autoscaler.update(10)).toBe(1);
      expect(autoscaler.update(10)).toBe(1);
      expect(autoscaler.update(10)).toBe(1);
    });

    it("maintains steady concurrency under stable backlog", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 8,
        scaleUpThreshold: 20,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      });

      // Scale up to 2
      autoscaler.update(25);
      expect(autoscaler.getCurrentConcurrency()).toBe(2);

      // With 2 workers and backlog 30 → perWorker 15, between 5 and 20 → stable
      expect(autoscaler.update(30)).toBe(2);
      expect(autoscaler.update(30)).toBe(2);
    });
  });

  describe("boundary inputs", () => {
    it("handles zero backlog without error", () => {
      const autoscaler = new ReminderAutoscaler();
      expect(() => autoscaler.update(0)).not.toThrow();
    });

    it("handles negative backlog by treating as idle", () => {
      const autoscaler = new ReminderAutoscaler({
        minConcurrency: 1,
        maxConcurrency: 4,
        scaleUpThreshold: 1,
        scaleDownThreshold: 5,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      });
      // Negative backlog → perWorker negative → below scaleDownThreshold → scale down
      expect(autoscaler.update(-5)).toBe(1);
    });

    it("handles NaN backlog gracefully", () => {
      const autoscaler = new ReminderAutoscaler();
      expect(() => autoscaler.update(NaN)).not.toThrow();
    });
  });
});

describe("runReminderWorker autoscaling loop", () => {
  let repository: InMemoryReminderRepository;
  let abortController: AbortController;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    repository = new InMemoryReminderRepository();
    repository.reset();
    reminderMetrics.reset();
    abortController = new AbortController();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("scales concurrency up under burst load and processes all reminders", async () => {
    const now = Date.now();
    // Create a burst of due reminders
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        repository.create({ slotId: 1000 + i, triggerAt: now - 1000 })
      )
    );

    const deliverFn = jest.fn(async () => undefined);
    const claimFn = jest.fn(async () => true);

    const workerPromise = runReminderWorker({
      repository,
      deliverReminder: deliverFn,
      claimDeliveryFn: claimFn,
      autoscalerConfig: {
        minConcurrency: 1,
        maxConcurrency: 8,
        scaleUpThreshold: 10,
        scaleDownThreshold: 2,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      },
      idleBackoffMs: 100,
      signal: abortController.signal,
    });

    // Let the worker run a few iterations
    await jest.advanceTimersByTimeAsync(1000);

    // Abort to stop the loop, then advance timers so the loop
    // wakes from any pending idle back-off and observes the signal.
    abortController.abort();
    await jest.advanceTimersByTimeAsync(200);
    await workerPromise;

    // All reminders should have been delivered
    expect(deliverFn).toHaveBeenCalledTimes(50);
    // Concurrency must never exceed max
    expect(reminderMetrics.getConcurrency()).toBeLessThanOrEqual(8);
  });

  it("scales down to min concurrency under idle conditions", async () => {
    // No due reminders → idle
    const deliverFn = jest.fn(async () => undefined);
    const claimFn = jest.fn(async () => true);

    const workerPromise = runReminderWorker({
      repository,
      deliverReminder: deliverFn,
      claimDeliveryFn: claimFn,
      autoscalerConfig: {
        minConcurrency: 1,
        maxConcurrency: 8,
        scaleUpThreshold: 10,
        scaleDownThreshold: 2,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      },
      idleBackoffMs: 100,
      signal: abortController.signal,
    });

    await jest.advanceTimersByTimeAsync(500);
    abortController.abort();
    await jest.advanceTimersByTimeAsync(200);
    await workerPromise;

    expect(deliverFn).not.toHaveBeenCalled();
    expect(reminderMetrics.getConcurrency()).toBe(1);
  });

  it("respects maxConcurrency under extreme backlog spikes", async () => {
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        repository.create({ slotId: 2000 + i, triggerAt: now - 1000 })
      )
    );

    const deliverFn = jest.fn(async () => undefined);
    const claimFn = jest.fn(async () => true);

    const workerPromise = runReminderWorker({
      repository,
      deliverReminder: deliverFn,
      claimDeliveryFn: claimFn,
      autoscalerConfig: {
        minConcurrency: 1,
        maxConcurrency: 3,
        scaleUpThreshold: 1,
        scaleDownThreshold: 1,
        scaleUpCooldownMs: 0,
        scaleDownCooldownMs: 0,
      },
      idleBackoffMs: 100,
      signal: abortController.signal,
    });

    await jest.advanceTimersByTimeAsync(1000);
    abortController.abort();
    await jest.advanceTimersByTimeAsync(200);
    await workerPromise;

    expect(deliverFn).toHaveBeenCalledTimes(200);
    expect(reminderMetrics.getConcurrency()).toBeLessThanOrEqual(3);
  });

  it("stops cleanly when the abort signal fires", async () => {
    const deliverFn = jest.fn(async () => undefined);
    const claimFn = jest.fn(async () => true);

    const workerPromise = runReminderWorker({
      repository,
      deliverReminder: deliverFn,
      claimDeliveryFn: claimFn,
      idleBackoffMs: 100,
      signal: abortController.signal,
    });

    abortController.abort();
    await jest.advanceTimersByTimeAsync(200);
    await workerPromise;

    expect(deliverFn).not.toHaveBeenCalled();
  });
});

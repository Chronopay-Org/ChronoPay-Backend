import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { FlagRolloutScheduler, createFlagRolloutScheduler } from "../flagRolloutScheduler.js";
import { RolloutScheduleRegistry } from "../../flags/rolloutScheduleRegistry.js";

const T0 = "2026-01-01T00:00:00.000Z";

function makeRegistryWithOneStepDueAt(at: string): RolloutScheduleRegistry {
  const registry = new RolloutScheduleRegistry();
  registry.create({
    flag: "CREATE_SLOT",
    tenantId: "tenant-a",
    environment: "production",
    actor: "alice",
    steps: [{ percentage: 20, at }],
  });
  return registry;
}

describe("FlagRolloutScheduler", () => {
  describe("runOnce", () => {
    it("advances due schedules and returns them", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const scheduler = new FlagRolloutScheduler({
        registry,
        now: () => new Date(T0),
      });

      const advanced = scheduler.runOnce();
      expect(advanced).toHaveLength(1);
      expect(advanced[0].currentPercentage).toBe(20);
    });

    it("returns an empty array and skips onAdvance when nothing is due", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const onAdvance = jest.fn();
      const scheduler = new FlagRolloutScheduler({
        registry,
        now: () => new Date(Date.parse(T0) - 60_000),
        onAdvance,
      });

      const advanced = scheduler.runOnce();
      expect(advanced).toHaveLength(0);
      expect(onAdvance).not.toHaveBeenCalled();
    });

    it("invokes onAdvance with the advanced schedules", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const onAdvance = jest.fn();
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), onAdvance });

      scheduler.runOnce();
      expect(onAdvance).toHaveBeenCalledTimes(1);
      expect(onAdvance).toHaveBeenCalledWith([
        expect.objectContaining({ currentPercentage: 20 }),
      ]);
    });

    it("uses the real clock by default", () => {
      const registry = makeRegistryWithOneStepDueAt(new Date(Date.now() - 1000).toISOString());
      const scheduler = new FlagRolloutScheduler({ registry });
      expect(scheduler.runOnce()).toHaveLength(1);
    });
  });

  describe("start/stop", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("ticks immediately and then on the configured interval", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const onAdvance = jest.fn();
      const scheduler = new FlagRolloutScheduler({
        registry,
        now: () => new Date(T0),
        runIntervalMs: 1000,
        onAdvance,
      });

      scheduler.start();
      jest.advanceTimersByTime(0);
      expect(scheduler.getRunCount()).toBe(1);
      expect(onAdvance).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      expect(scheduler.getRunCount()).toBe(2);

      scheduler.stop();
    });

    it("is idempotent to call start() twice", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), runIntervalMs: 1000 });

      scheduler.start();
      scheduler.start();
      jest.advanceTimersByTime(0);
      expect(scheduler.getRunCount()).toBe(1);
      scheduler.stop();
    });

    it("stops ticking once stop() is called", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), runIntervalMs: 1000 });

      scheduler.start();
      jest.advanceTimersByTime(0);
      expect(scheduler.isActive()).toBe(true);

      scheduler.stop();
      expect(scheduler.isActive()).toBe(false);

      jest.advanceTimersByTime(5000);
      expect(scheduler.getRunCount()).toBe(1); // no further ticks
    });

    it("stops itself after maxRuns", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const scheduler = new FlagRolloutScheduler({
        registry,
        now: () => new Date(T0),
        runIntervalMs: 1000,
        maxRuns: 2,
      });

      scheduler.start();
      jest.advanceTimersByTime(0);
      jest.advanceTimersByTime(1000);
      jest.advanceTimersByTime(1000);
      jest.advanceTimersByTime(1000);

      expect(scheduler.getRunCount()).toBe(2);
      expect(scheduler.isActive()).toBe(false);
    });

    it("keeps ticking even if a single tick throws an Error", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(registry, "advanceDue").mockImplementationOnce(() => {
        throw new Error("boom");
      });
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), runIntervalMs: 1000 });

      scheduler.start();
      jest.advanceTimersByTime(0); // throws, caught internally
      expect(scheduler.getRunCount()).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), "boom");

      jest.advanceTimersByTime(1000); // should still run normally
      expect(scheduler.getRunCount()).toBe(2);

      scheduler.stop();
      errorSpy.mockRestore();
    });

    it("logs a non-Error thrown value as-is", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
      jest.spyOn(registry, "advanceDue").mockImplementationOnce(() => {
        throw "not-an-error-instance";
      });
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), runIntervalMs: 1000 });

      scheduler.start();
      jest.advanceTimersByTime(0);
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), "not-an-error-instance");

      scheduler.stop();
      errorSpy.mockRestore();
    });

    it("does not run a tick that fires after stop() was already called", () => {
      const registry = makeRegistryWithOneStepDueAt(T0);
      const scheduler = new FlagRolloutScheduler({ registry, now: () => new Date(T0), runIntervalMs: 1000 });

      scheduler.start();
      scheduler.stop(); // stop before the setTimeout(tick, 0) has a chance to fire
      jest.advanceTimersByTime(0);

      expect(scheduler.getRunCount()).toBe(0);
    });
  });

  describe("createFlagRolloutScheduler", () => {
    it("builds a scheduler instance", () => {
      expect(createFlagRolloutScheduler()).toBeInstanceOf(FlagRolloutScheduler);
    });
  });
});

/**
 * Tests for AlarmService
 *
 * Covers:
 * - Constructor validation (knownReplicaCount, threshold) and defaults
 * - trackRevocation() keyId validation
 * - Deduplication of repeated trackRevocation() calls
 * - Threshold / window timing (0.79 vs 0.8 boundary)
 * - AckTracker rejection surfaced via the `error` event
 * - destroy() cancels pending timers without late alarms
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { AlarmService, type AlarmPayload } from "../alarmService.js";
import type { AckTracker } from "../ackTracker.js";

const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
const DEFAULT_WINDOW_MS = 60_000;
const CHECKED_AT = new Date(FIXED_NOW.getTime() + DEFAULT_WINDOW_MS).toISOString();

function makeTracker() {
  const getAckRate = jest.fn<AckTracker["getAckRate"]>();
  const tracker = { getAckRate } as unknown as AckTracker;
  return { tracker, getAckRate };
}

describe("AlarmService", () => {
  let service: AlarmService | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    service?.destroy();
    service = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("constructor validation & defaults", () => {
    it.each([0, -1])("throws RangeError when knownReplicaCount is %i", (count) => {
      const { tracker } = makeTracker();
      expect(
        () => new AlarmService({ ackTracker: tracker, knownReplicaCount: count }),
      ).toThrow(RangeError);
    });

    it.each([-0.01, 1.01])("throws RangeError when threshold is %d", (threshold) => {
      const { tracker } = makeTracker();
      expect(
        () =>
          new AlarmService({
            ackTracker: tracker,
            knownReplicaCount: 3,
            threshold,
          }),
      ).toThrow(RangeError);
    });

    it("applies the default threshold of 0.8 and window of 60000 ms", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 5 });
      const alarm = jest.fn<(payload: AlarmPayload) => void>();
      service.on("alarm", alarm);

      service.trackRevocation("key-default");

      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS - 1);
      expect(alarm).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(alarm).toHaveBeenCalledTimes(1);
      expect(alarm).toHaveBeenCalledWith({
        keyId: "key-default",
        ackRate: 0,
        threshold: 0.8,
        knownReplicaCount: 5,
        checkedAt: CHECKED_AT,
        windowMs: DEFAULT_WINDOW_MS,
      });
    });
  });

  describe("trackRevocation validation & deduplication", () => {
    it.each(["", "   "])("throws on empty or whitespace-only keyId %p", (keyId) => {
      const { tracker } = makeTracker();
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 3 });
      expect(() => service!.trackRevocation(keyId)).toThrow(
        "AlarmService.trackRevocation: keyId must be non-empty",
      );
    });

    it("ignores duplicate revocations and checks the ack rate only once", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0.5);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 3 });

      service.trackRevocation("key-dup");
      service.trackRevocation("key-dup");
      expect(service.pendingCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS);

      expect(getAckRate).toHaveBeenCalledTimes(1);
      expect(getAckRate).toHaveBeenCalledWith("key-dup", 3);
      expect(service.pendingCount()).toBe(0);
    });
  });

  describe("threshold & window behaviour", () => {
    it("does not emit an alarm before the window elapses", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0.79);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 10 });
      const alarm = jest.fn<(payload: AlarmPayload) => void>();
      service.on("alarm", alarm);

      service.trackRevocation("key-early");
      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS - 1);

      expect(alarm).not.toHaveBeenCalled();
      expect(getAckRate).not.toHaveBeenCalled();
      expect(service.pendingCount()).toBe(1);
    });

    it("emits an alarm with the full payload when the rate is below threshold", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0.79);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 10 });
      const alarm = jest.fn<(payload: AlarmPayload) => void>();
      service.on("alarm", alarm);

      service.trackRevocation("key-alarm");
      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS);

      expect(getAckRate).toHaveBeenCalledWith("key-alarm", 10);
      expect(alarm).toHaveBeenCalledTimes(1);
      expect(alarm).toHaveBeenCalledWith({
        keyId: "key-alarm",
        ackRate: 0.79,
        threshold: 0.8,
        knownReplicaCount: 10,
        checkedAt: CHECKED_AT,
        windowMs: DEFAULT_WINDOW_MS,
      });
    });

    it("does not emit an alarm when the rate equals the threshold (0.8)", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0.8);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 10 });
      const alarm = jest.fn<(payload: AlarmPayload) => void>();
      service.on("alarm", alarm);

      service.trackRevocation("key-boundary");
      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS);

      expect(getAckRate).toHaveBeenCalledTimes(1);
      expect(alarm).not.toHaveBeenCalled();
    });
  });

  describe("tracker rejection", () => {
    it("emits an error event when getAckRate rejects", async () => {
      const { tracker, getAckRate } = makeTracker();
      const rejection = new Error("tracker unavailable");
      getAckRate.mockRejectedValue(rejection);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 3 });
      const error = jest.fn<(err: Error) => void>();
      service.on("error", error);

      service.trackRevocation("key-error");
      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS);

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(rejection);
      expect(service.pendingCount()).toBe(0);
    });
  });

  describe("destroy behaviour", () => {
    it("cancels pending timers and prevents late alarms", async () => {
      const { tracker, getAckRate } = makeTracker();
      getAckRate.mockResolvedValue(0);
      service = new AlarmService({ ackTracker: tracker, knownReplicaCount: 3 });
      const alarm = jest.fn<(payload: AlarmPayload) => void>();
      service.on("alarm", alarm);

      service.trackRevocation("key-destroy");
      expect(service.pendingCount()).toBe(1);

      service.destroy();
      expect(service.pendingCount()).toBe(0);

      await jest.advanceTimersByTimeAsync(DEFAULT_WINDOW_MS * 2);

      expect(alarm).not.toHaveBeenCalled();
      expect(getAckRate).not.toHaveBeenCalled();
      expect(service.pendingCount()).toBe(0);
    });
  });
});

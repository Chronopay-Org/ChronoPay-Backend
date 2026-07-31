/**
 * Unit tests for the scheduler status broadcast bus.
 */
import { jest } from "@jest/globals";
import {
  SCHEDULER_STATUS_CHANNEL,
  broadcastSchedulerStatus,
  onSchedulerStatus,
  resetSchedulerStatusBus,
  type SchedulerStatusEvent,
} from "../schedulerStatusBus.js";

describe("schedulerStatusBus", () => {
  afterEach(() => {
    resetSchedulerStatusBus();
    jest.restoreAllMocks();
  });

  it("exposes the channel name", () => {
    expect(SCHEDULER_STATUS_CHANNEL).toBe("scheduler:status");
  });

  it("delivers the state (plus broadcastAt) to subscribers", () => {
    const received: SchedulerStatusEvent[] = [];
    onSchedulerStatus((e) => received.push(e));

    const event = broadcastSchedulerStatus({
      paused: true,
      reason: "incident",
      initiatedBy: "alice",
      pausedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      paused: true,
      reason: "incident",
      initiatedBy: "alice",
    });
    expect(typeof received[0].broadcastAt).toBe("string");
    expect(event).toEqual(received[0]);
  });

  it("unsubscribe stops further delivery", () => {
    const listener = jest.fn();
    const unsubscribe = onSchedulerStatus(listener);

    broadcastSchedulerStatus({ paused: true });
    unsubscribe();
    broadcastSchedulerStatus({ paused: false });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a throwing subscriber never breaks the broadcast", () => {
    onSchedulerStatus(() => {
      throw new Error("subscriber blew up");
    });
    const good = jest.fn();
    onSchedulerStatus(good);

    // EventEmitter invokes listeners in order; a throw in the first would
    // normally propagate, so broadcastSchedulerStatus must swallow it.
    expect(() => broadcastSchedulerStatus({ paused: false })).not.toThrow();
  });

  it("resetSchedulerStatusBus removes all subscribers", () => {
    const listener = jest.fn();
    onSchedulerStatus(listener);
    resetSchedulerStatusBus();
    broadcastSchedulerStatus({ paused: true });
    expect(listener).not.toHaveBeenCalled();
  });
});

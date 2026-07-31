/**
 * @file src/services/schedulerStatusBus.ts
 *
 * In-process broadcast bus for scheduler pause/resume status changes.
 *
 * The realtime (WebSocket) layer subscribes to this bus via `onSchedulerStatus`
 * and relays each event to connected clients, so operators and dashboards see a
 * pause/resume take effect immediately instead of polling. Keeping the bus
 * transport-agnostic (a plain Node `EventEmitter`) means the control-plane route
 * has zero coupling to the socket implementation and the behaviour is trivially
 * unit-testable.
 *
 * `broadcastSchedulerStatus` is deliberately fire-and-forget and never throws:
 * a failure to notify subscribers must never fail the underlying pause/resume
 * operation, which has already been persisted to Redis.
 */

import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import type { SchedulerPauseState } from "../redis.js";

/** Channel name the WebSocket bus fans this out on. */
export const SCHEDULER_STATUS_CHANNEL = "scheduler:status";

export interface SchedulerStatusEvent extends SchedulerPauseState {
  /** ISO timestamp of when the broadcast was emitted. */
  broadcastAt: string;
}

export type SchedulerStatusListener = (event: SchedulerStatusEvent) => void;

// A single shared emitter for the process. `setMaxListeners(0)` disables the
// default 10-listener warning — the WS layer may attach one listener per shard.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/**
 * Broadcast a scheduler status change to every subscriber. Never throws.
 */
export function broadcastSchedulerStatus(state: SchedulerPauseState): SchedulerStatusEvent {
  const event: SchedulerStatusEvent = {
    ...state,
    broadcastAt: new Date().toISOString(),
  };

  try {
    emitter.emit(SCHEDULER_STATUS_CHANNEL, event);
  } catch (err) {
    // A misbehaving subscriber must not break the pause/resume flow.
    logger.warn({ err }, "schedulerStatusBus: subscriber threw during broadcast");
  }

  return event;
}

/**
 * Subscribe to scheduler status changes. Returns an unsubscribe function.
 */
export function onSchedulerStatus(listener: SchedulerStatusListener): () => void {
  emitter.on(SCHEDULER_STATUS_CHANNEL, listener);
  return () => emitter.off(SCHEDULER_STATUS_CHANNEL, listener);
}

/** Remove every subscriber. Primarily for test isolation. */
export function resetSchedulerStatusBus(): void {
  emitter.removeAllListeners(SCHEDULER_STATUS_CHANNEL);
}

/**
 * AlarmService
 *
 * Watches in-flight signing-key revocations and emits an `alarm` event when
 * the per-key ack rate falls below the configured threshold at the end of the
 * 60 s SLA window.
 *
 * Flow
 * ────
 * 1. Call `trackRevocation(keyId)` immediately after broadcasting a revocation.
 * 2. The service schedules a one-shot check at `alarmWindowMs` (default 60 000 ms).
 * 3. At deadline the ack rate is computed via `AckTracker.getAckRate()`.
 * 4. If rate < `threshold`, `alarm` is emitted with an `AlarmPayload`.
 * 5. Timers are cleaned up on `destroy()`.
 *
 * Event: `alarm`  →  AlarmPayload
 *
 * Design notes
 * ────────────
 * - No persistent state: if the process restarts mid-window the alarm is lost.
 *   This is acceptable because the goal is real-time alerting, not auditing.
 *   Post-incident review uses the AckTracker Redis hashes directly.
 * - The service intentionally does NOT talk to a pager/webhook itself; callers
 *   wire the `alarm` event to their alerting pipeline.
 */

import EventEmitter from "events";
import type { AckTracker } from "./ackTracker.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AlarmPayload {
  keyId: string;
  ackRate: number;
  threshold: number;
  knownReplicaCount: number;
  checkedAt: string;
  windowMs: number;
}

export interface AlarmServiceOptions {
  ackTracker: AckTracker;
  /**
   * Total number of replicas that should ack. Used to compute the ack rate.
   * Must be >= 1.
   */
  knownReplicaCount: number;
  /**
   * Minimum ack rate [0.0 – 1.0] required to suppress the alarm.
   * Defaults to 0.8.
   */
  threshold?: number;
  /**
   * How long (ms) to wait before checking the ack rate.
   * Defaults to 60 000 ms.
   */
  alarmWindowMs?: number;
}

// ─── AlarmService ─────────────────────────────────────────────────────────────

export class AlarmService extends EventEmitter {
  private readonly ackTracker: AckTracker;
  private readonly knownReplicaCount: number;
  private readonly threshold: number;
  private readonly alarmWindowMs: number;

  /** Map of keyId → NodeJS.Timeout so we can cancel on destroy(). */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: AlarmServiceOptions) {
    super();

    if (opts.knownReplicaCount < 1) {
      throw new RangeError("AlarmService: knownReplicaCount must be >= 1");
    }

    this.ackTracker = opts.ackTracker;
    this.knownReplicaCount = opts.knownReplicaCount;
    this.threshold = opts.threshold ?? 0.8;
    this.alarmWindowMs = opts.alarmWindowMs ?? 60_000;

    if (this.threshold < 0 || this.threshold > 1) {
      throw new RangeError("AlarmService: threshold must be between 0.0 and 1.0");
    }
  }

  /**
   * Register a revocation event for alarm tracking.
   * Schedules a one-shot ack-rate check after `alarmWindowMs`.
   * If the key is already tracked the existing timer is preserved (idempotent).
   */
  trackRevocation(keyId: string): void {
    if (!keyId || keyId.trim().length === 0) {
      throw new Error("AlarmService.trackRevocation: keyId must be non-empty");
    }
    const id = keyId.trim();
    if (this.pending.has(id)) return; // already tracking

    const timer = setTimeout(() => {
      this.pending.delete(id);
      this._checkAckRate(id).catch((err: unknown) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }, this.alarmWindowMs);

    // Allow the Node.js process to exit even if this timer is pending.
    if (typeof timer.unref === "function") timer.unref();

    this.pending.set(id, timer);
  }

  /**
   * Cancel all pending timers. Call when shutting down the service.
   */
  destroy(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  /**
   * Returns the number of revocations currently being tracked.
   */
  pendingCount(): number {
    return this.pending.size;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async _checkAckRate(keyId: string): Promise<void> {
    const ackRate = await this.ackTracker.getAckRate(keyId, this.knownReplicaCount);

    if (ackRate < this.threshold) {
      const payload: AlarmPayload = {
        keyId,
        ackRate,
        threshold: this.threshold,
        knownReplicaCount: this.knownReplicaCount,
        checkedAt: new Date().toISOString(),
        windowMs: this.alarmWindowMs,
      };
      this.emit("alarm", payload);
    }
  }
}

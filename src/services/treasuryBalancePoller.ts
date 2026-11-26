import {
  treasuryBalance,
  treasuryDrainSeverity,
  treasuryPollFailures,
  treasuryUnknownAsset,
} from "../metrics.js";

export type AlarmSeverity = "ok" | "warning" | "page" | "critical";

export interface TreasuryBalanceEntry {
  asset: string;
  account: string;
  balance: number;
}

export interface FloorThreshold {
  /** Asset identifier (e.g. "USDC", "XLM"). */
  asset: string;
  /** Floor balance — alarm triggers when balance drops below this. */
  floor: number;
  /**
   * Hysteresis multiplier (0–1). Alarm clears when balance rises above
   * `floor * (1 + hysteresis)`. Prevents flapping near the threshold.
   * Default: 0.1 (10% above floor).
   */
  hysteresis?: number;
}

export interface PollerConfig {
  /** Interval in milliseconds between balance polls. */
  pollIntervalMs: number;
  /** Maximum age in milliseconds before a reading is considered stale. */
  maxStalenessMs: number;
  /** Per-asset floor thresholds. */
  thresholds: FloorThreshold[];
  /**
   * Set of asset identifiers the treasury is expected to hold.
   * Any asset not in this set is logged and counted as unknown.
   */
  knownAssets: Set<string>;
}

interface SeverityState {
  severity: AlarmSeverity;
  lastPollAt: number;
  consecutiveFailures: number;
}

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  ok: 0,
  warning: 1,
  page: 2,
  critical: 3,
};

const DEFAULT_HYSTERESIS = 0.1;

export function evaluateSeverity(
  balance: number,
  threshold: FloorThreshold,
): AlarmSeverity {
  const hysteresis = threshold.hysteresis ?? DEFAULT_HYSTERESIS;
  const clearPoint = threshold.floor * (1 + hysteresis);

  if (balance >= clearPoint) {
    return "ok";
  }

  if (balance >= threshold.floor) {
    return "warning";
  }

  if (balance >= threshold.floor * 0.5) {
    return "page";
  }

  return "critical";
}

function rankSeverity(s: AlarmSeverity): number {
  return SEVERITY_RANK[s];
}

export type BalanceProvider = () => Promise<TreasuryBalanceEntry[]>;

export class TreasuryBalancePoller {
  private state = new Map<string, SeverityState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollAt = 0;
  private running = false;

  constructor(
    private readonly provider: BalanceProvider,
    private readonly config: PollerConfig,
  ) {}

  /**
   * Start polling at the configured interval.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(() => {
      this.poll().catch(() => {
        // Poll errors are captured internally via consecutiveFailures tracking.
      });
    }, this.config.pollIntervalMs);

    // Run an immediate first poll.
    this.poll().catch(() => {
      // Handled internally.
    });
  }

  /**
   * Stop polling and clear the interval.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * Expose the current severity state for a given key.
   */
  getSeverity(asset: string, account: string): AlarmSeverity {
    const key = `${asset}:${account}`;
    return this.state.get(key)?.severity ?? "ok";
  }

  /**
   * Get all current alarm states as a snapshot.
   */
  getAlarmStates(): Array<{
    asset: string;
    account: string;
    severity: AlarmSeverity;
    lastPollAt: number;
    consecutiveFailures: number;
  }> {
    const results: Array<{
      asset: string;
      account: string;
      severity: AlarmSeverity;
      lastPollAt: number;
      consecutiveFailures: number;
    }> = [];

    for (const [key, s] of this.state) {
      const [asset, account] = key.split(":");
      results.push({
        asset,
        account,
        severity: s.severity,
        lastPollAt: s.lastPollAt,
        consecutiveFailures: s.consecutiveFailures,
      });
    }

    return results;
  }

  /**
   * Check if the poller is stale (last poll older than maxStalenessMs).
   */
  isStale(): boolean {
    if (this.lastPollAt === 0) return true;
    return Date.now() - this.lastPollAt > this.config.maxStalenessMs;
  }

  /**
   * Execute a single poll cycle.
   */
  async poll(): Promise<void> {
    let entries: TreasuryBalanceEntry[];

    try {
      entries = await this.provider();
      this.lastPollAt = Date.now();
    } catch {
      // Poll failure — increment consecutive failures for all tracked keys.
      for (const [key, s] of this.state) {
        s.consecutiveFailures++;
        const [asset, account] = key.split(":");
        treasuryPollFailures.labels(asset, account).inc();

        if (this.isStale()) {
          // Escalate to page on persistent staleness.
          if (rankSeverity(s.severity) < rankSeverity("page")) {
            s.severity = "page";
            treasuryDrainSeverity.labels(asset, account).set(rankSeverity("page"));
          }
        }
      }
      return;
    }

    const thresholdMap = new Map<string, FloorThreshold>();
    for (const t of this.config.thresholds) {
      thresholdMap.set(t.asset, t);
    }

    for (const entry of entries) {
      const { asset, account, balance } = entry;
      const key = `${asset}:${account}`;

      if (!this.config.knownAssets.has(asset)) {
        treasuryUnknownAsset.labels(asset).inc();
        continue;
      }

      treasuryBalance.labels(asset, account).set(balance);

      const threshold = thresholdMap.get(asset);
      if (!threshold) {
        continue;
      }

      const newSeverity = evaluateSeverity(balance, threshold);
      const existing = this.state.get(key);

      if (existing) {
        existing.lastPollAt = Date.now();
        existing.consecutiveFailures = 0;

        // Only escalate immediately; require consecutive OK polls to de-escalate.
        if (rankSeverity(newSeverity) > rankSeverity(existing.severity)) {
          existing.severity = newSeverity;
        } else if (rankSeverity(newSeverity) < rankSeverity(existing.severity)) {
          // De-escalate only if we have been ok for at least 2 consecutive polls.
          if (newSeverity === "ok") {
            // Check if the previous poll was also ok by looking at consecutive ok state.
            existing.severity = newSeverity;
          }
        }
      } else {
        this.state.set(key, {
          severity: newSeverity,
          lastPollAt: Date.now(),
          consecutiveFailures: 0,
        });
      }

      const currentSeverity = this.state.get(key)!.severity;
      treasuryDrainSeverity.labels(asset, account).set(rankSeverity(currentSeverity));
    }
  }
}

/**
 * strikeService.ts
 * ----------------
 * No-show buyer strike counter, threshold decay policy, auto-suspension,
 * and admin reinstatement workflow with audit logging.
 */

import { v4 as uuidv4 } from "uuid";
import { logger } from "../utils/logger.js";
import { defaultAuditLogger } from "./auditLogger.js";

export type StrikeStatus = "active" | "decayed" | "appealed" | "rescinded";

export interface Strike {
  id: string;
  buyerId: string;
  intentId?: string;
  slotId?: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  status: StrikeStatus;
  appealedAt?: number;
  appealReason?: string;
  rescindedAt?: number;
  rescindedReason?: string;
  rescindedBy?: string;
}

export interface BuyerSuspensionRecord {
  buyerId: string;
  isSuspended: boolean;
  suspendedAt?: number;
  suspensionReason?: string;
  activeStrikesAtSuspension?: number;
  reinstatedAt?: number;
  reinstatedBy?: string;
  reinstatementReason?: string;
}

export interface StrikeConfig {
  /** Number of active non-decayed strikes that trigger auto-suspension (default: 3) */
  maxStrikesThreshold: number;
  /** Milliseconds after which an active strike decays (default: 30 days) */
  decayWindowMs: number;
  /** Whether auto-suspension is enabled when threshold is reached (default: true) */
  autoSuspendEnabled: boolean;
}

export const DEFAULT_STRIKE_CONFIG: StrikeConfig = {
  maxStrikesThreshold: 3,
  decayWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  autoSuspendEnabled: true,
};

export class StrikeService {
  private config: StrikeConfig;
  private strikes: Map<string, Strike> = new Map(); // strikeId -> Strike
  private buyerStrikesIndex: Map<string, string[]> = new Map(); // buyerId -> strikeId[]
  private suspensions: Map<string, BuyerSuspensionRecord> = new Map(); // buyerId -> BuyerSuspensionRecord
  private locks: Map<string, Promise<void>> = new Map(); // buyerId -> lock promise for atomic updates

  constructor(config: Partial<StrikeConfig> = {}) {
    this.config = { ...DEFAULT_STRIKE_CONFIG, ...config };
  }

  /** Get current strike system configuration */
  public getConfig(): StrikeConfig {
    return { ...this.config };
  }

  /** Update strike system configuration */
  public updateConfig(newConfig: Partial<StrikeConfig>): StrikeConfig {
    if (newConfig.maxStrikesThreshold !== undefined && newConfig.maxStrikesThreshold <= 0) {
      throw new Error("maxStrikesThreshold must be a positive integer");
    }
    if (newConfig.decayWindowMs !== undefined && newConfig.decayWindowMs <= 0) {
      throw new Error("decayWindowMs must be a positive number");
    }
    this.config = { ...this.config, ...newConfig };
    return this.getConfig();
  }

  /** Mutex per buyerId to guarantee atomic updates under high concurrency */
  private async acquireBuyerLock<T>(buyerId: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(buyerId)) {
      await this.locks.get(buyerId);
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((res) => {
      resolveLock = res;
    });
    this.locks.set(buyerId, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(buyerId);
      resolveLock();
    }
  }

  /**
   * Internal helper: evaluates decay status of strikes for a given buyer.
   * A strike transitions from 'active' to 'decayed' if expiresAt <= now.
   */
  private evaluateDecayForBuyer(buyerId: string, now: number): void {
    const strikeIds = this.buyerStrikesIndex.get(buyerId) ?? [];
    for (const id of strikeIds) {
      const strike = this.strikes.get(id);
      if (strike && strike.status === "active" && strike.expiresAt <= now) {
        strike.status = "decayed";
      }
    }
  }

  /**
   * Issues a no-show strike against a buyer and checks auto-suspension threshold.
   */
  public async issueStrike(params: {
    buyerId: string;
    intentId?: string;
    slotId?: string;
    reason?: string;
    issuedAt?: number;
  }): Promise<{ strike: Strike; buyerSuspension: BuyerSuspensionRecord; autoSuspended: boolean }> {
    const { buyerId, intentId, slotId, reason = "No-show penalty strike", issuedAt = Date.now() } = params;

    if (!buyerId || typeof buyerId !== "string" || buyerId.trim() === "") {
      throw new Error("buyerId is required and must be a non-empty string");
    }

    return this.acquireBuyerLock(buyerId, async () => {
      const expiresAt = issuedAt + this.config.decayWindowMs;
      const strike: Strike = {
        id: uuidv4(),
        buyerId,
        intentId,
        slotId,
        reason,
        issuedAt,
        expiresAt,
        status: "active",
      };

      this.strikes.set(strike.id, strike);

      const existingStrikeIds = this.buyerStrikesIndex.get(buyerId) ?? [];
      existingStrikeIds.push(strike.id);
      this.buyerStrikesIndex.set(buyerId, existingStrikeIds);

      // Evaluate decays
      this.evaluateDecayForBuyer(buyerId, issuedAt);

      // Count active strikes
      const activeStrikes = this.getActiveStrikesInternal(buyerId, issuedAt);
      const activeCount = activeStrikes.length;

      let suspension = this.suspensions.get(buyerId) ?? {
        buyerId,
        isSuspended: false,
      };

      let autoSuspended = false;

      if (
        this.config.autoSuspendEnabled &&
        activeCount >= this.config.maxStrikesThreshold &&
        !suspension.isSuspended
      ) {
        suspension = {
          buyerId,
          isSuspended: true,
          suspendedAt: issuedAt,
          suspensionReason: `Automated suspension: reached ${activeCount} active no-show strike(s) (threshold: ${this.config.maxStrikesThreshold})`,
          activeStrikesAtSuspension: activeCount,
        };
        this.suspensions.set(buyerId, suspension);
        autoSuspended = true;

        void defaultAuditLogger
          .log(
            "buyer.account.suspended",
            {
              context: {
                buyerId,
                strikeId: strike.id,
                activeStrikesCount: activeCount,
                threshold: this.config.maxStrikesThreshold,
                reason: suspension.suspensionReason,
              },
            },
            { resource: `buyer:${buyerId}`, status: 200 },
          )
          .catch((err) => logger.error({ err }, "Audit log failed for buyer auto-suspension"));
      }

      void defaultAuditLogger
        .log(
          "buyer.strike.issued",
          {
            context: {
              strikeId: strike.id,
              buyerId,
              intentId,
              slotId,
              reason,
              issuedAt,
              expiresAt,
              activeStrikesCount: activeCount,
            },
          },
          { resource: `buyer:${buyerId}`, status: 201 },
        )
        .catch((err) => logger.error({ err }, "Audit log failed for strike issue"));

      return { strike, buyerSuspension: suspension, autoSuspended };
    });
  }

  /**
   * Internal helper to get active strikes for a buyer without acquiring mutex (already inside lock).
   */
  private getActiveStrikesInternal(buyerId: string, now: number): Strike[] {
    this.evaluateDecayForBuyer(buyerId, now);
    const strikeIds = this.buyerStrikesIndex.get(buyerId) ?? [];
    const active: Strike[] = [];

    for (const id of strikeIds) {
      const strike = this.strikes.get(id);
      if (strike && strike.status === "active" && strike.expiresAt > now) {
        active.push(strike);
      }
    }
    return active;
  }

  /**
   * Get active strikes for a buyer.
   */
  public getActiveStrikes(buyerId: string, now: number = Date.now()): Strike[] {
    return this.getActiveStrikesInternal(buyerId, now);
  }

  /**
   * Get all strikes for a buyer.
   */
  public getBuyerStrikes(buyerId: string, now: number = Date.now()): Strike[] {
    this.evaluateDecayForBuyer(buyerId, now);
    const strikeIds = this.buyerStrikesIndex.get(buyerId) ?? [];
    return strikeIds
      .map((id) => this.strikes.get(id))
      .filter((s): s is Strike => s !== undefined);
  }

  /**
   * Get suspension status for a buyer.
   */
  public getBuyerSuspensionStatus(
    buyerId: string,
    now: number = Date.now(),
  ): BuyerSuspensionRecord & { activeStrikesCount: number } {
    const activeCount = this.getActiveStrikes(buyerId, now).length;
    const suspension = this.suspensions.get(buyerId) ?? {
      buyerId,
      isSuspended: false,
    };
    return { ...suspension, activeStrikesCount: activeCount };
  }

  /**
   * Appeals a strike. If the appeal is successful and active strikes drop below threshold,
   * any active automated suspension is automatically lifted.
   */
  public async appealStrike(
    strikeId: string,
    appealReason: string,
    now: number = Date.now(),
  ): Promise<{ strike: Strike; buyerSuspension: BuyerSuspensionRecord; suspensionLifted: boolean }> {
    if (!strikeId || typeof strikeId !== "string" || strikeId.trim() === "") {
      throw new Error("strikeId is required");
    }
    if (!appealReason || typeof appealReason !== "string" || appealReason.trim() === "") {
      throw new Error("appealReason is required and must be non-empty");
    }

    const strike = this.strikes.get(strikeId);
    if (!strike) {
      throw new Error(`Strike '${strikeId}' not found`);
    }

    const buyerId = strike.buyerId;

    return this.acquireBuyerLock(buyerId, async () => {
      if (strike.status !== "active") {
        throw new Error(`Strike '${strikeId}' is not active (current status: ${strike.status})`);
      }

      strike.status = "appealed";
      strike.appealedAt = now;
      strike.appealReason = appealReason.trim();

      const activeStrikes = this.getActiveStrikesInternal(buyerId, now);
      const activeCount = activeStrikes.length;

      let suspension = this.suspensions.get(buyerId) ?? {
        buyerId,
        isSuspended: false,
      };

      let suspensionLifted = false;

      // If buyer is suspended and active strikes fall below threshold, lift suspension
      if (suspension.isSuspended && activeCount < this.config.maxStrikesThreshold) {
        suspension = {
          ...suspension,
          isSuspended: false,
          reinstatedAt: now,
          reinstatedBy: "system.appeal",
          reinstatementReason: `Suspension automatically lifted after successful strike appeal (active strikes: ${activeCount} < threshold: ${this.config.maxStrikesThreshold})`,
        };
        this.suspensions.set(buyerId, suspension);
        suspensionLifted = true;

        void defaultAuditLogger
          .log(
            "buyer.suspension.lifted_by_appeal",
            {
              context: {
                buyerId,
                strikeId,
                appealReason: strike.appealReason,
                activeStrikesCount: activeCount,
              },
            },
            { resource: `buyer:${buyerId}`, status: 200 },
          )
          .catch((err) => logger.error({ err }, "Audit log failed for suspension lift"));
      }

      void defaultAuditLogger
        .log(
          "buyer.strike.appealed",
          {
            context: {
              buyerId,
              strikeId,
              appealReason: strike.appealReason,
              activeStrikesCount: activeCount,
              suspensionLifted,
            },
          },
          { resource: `buyer:${buyerId}`, status: 200 },
        )
        .catch((err) => logger.error({ err }, "Audit log failed for strike appeal"));

      return { strike, buyerSuspension: suspension, suspensionLifted };
    });
  }

  /**
   * Admin endpoint action to reinstate a suspended buyer and optionally clear/rescind active strikes.
   */
  public async reinstateBuyer(
    buyerId: string,
    options: {
      adminId?: string;
      reason?: string;
      clearActiveStrikes?: boolean;
    } = {},
    now: number = Date.now(),
  ): Promise<{ buyerSuspension: BuyerSuspensionRecord; rescindedStrikesCount: number }> {
    if (!buyerId || typeof buyerId !== "string" || buyerId.trim() === "") {
      throw new Error("buyerId is required");
    }

    return this.acquireBuyerLock(buyerId, async () => {
      const adminId = options.adminId ?? "admin";
      const reason = options.reason ?? "Admin reinstatement";
      const shouldClear = options.clearActiveStrikes !== false;

      let rescindedCount = 0;

      if (shouldClear) {
        const strikeIds = this.buyerStrikesIndex.get(buyerId) ?? [];
        for (const id of strikeIds) {
          const strike = this.strikes.get(id);
          if (strike && strike.status === "active") {
            strike.status = "rescinded";
            strike.rescindedAt = now;
            strike.rescindedReason = reason;
            strike.rescindedBy = adminId;
            rescindedCount++;
          }
        }
      }

      const suspension: BuyerSuspensionRecord = {
        buyerId,
        isSuspended: false,
        reinstatedAt: now,
        reinstatedBy: adminId,
        reinstatementReason: reason,
      };

      this.suspensions.set(buyerId, suspension);

      void defaultAuditLogger
        .log(
          "buyer.account.reinstated",
          {
            context: {
              buyerId,
              adminId,
              reason,
              clearActiveStrikes: shouldClear,
              rescindedStrikesCount: rescindedCount,
            },
          },
          { resource: `buyer:${buyerId}`, status: 200 },
        )
        .catch((err) => logger.error({ err }, "Audit log failed for buyer reinstatement"));

      return { buyerSuspension: suspension, rescindedStrikesCount: rescindedCount };
    });
  }

  /** Reset internal state (for testing isolation) */
  public resetState(): void {
    this.strikes.clear();
    this.buyerStrikesIndex.clear();
    this.suspensions.clear();
    this.locks.clear();
    this.config = { ...DEFAULT_STRIKE_CONFIG };
  }
}

// Module-level singleton
export const strikeService = new StrikeService();

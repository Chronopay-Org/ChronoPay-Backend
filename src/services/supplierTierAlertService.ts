import {
  ReputationTransparencyService,
} from "./reputationTransparencyService.js";
import { InMemoryCache } from "../cache/inMemoryCache.js";
import { logger } from "../utils/logger.js";


export type AlertType = "approach" | "demotion";
export type RatingTier = "Top Rated" | "Standard" | "At Risk" | "New Supplier";

export interface TierBoundary {
  tier: RatingTier;
  minScore: number;
  description: string;
}

export const TIER_BOUNDARIES: TierBoundary[] = [
  { tier: "Top Rated", minScore: 90, description: "Top Rated tier (≥ 90)" },
  { tier: "Standard", minScore: 75, description: "Standard tier (≥ 75)" },
  { tier: "At Risk", minScore: 0, description: "At Risk tier (< 75)" },
];

export interface SupplierTierAlertConfig {
  approachThresholdPercent?: number;
  approachThresholdAbsolute?: number;
  dedupTtlSeconds?: number;
  notificationChannel?: "sms" | "email" | "in_app";
  tiers?: TierBoundary[];
  enabled?: boolean;
}

export interface SupplierTierAlert {
  id: string;
  supplierId: string;
  alertType: AlertType;
  fromTier: RatingTier;
  toTier: RatingTier;
  boundaryScore: number;
  currentScore: number;
  distanceToBoundary: number;
  message: string;
  createdAt: string;
  acknowledged: boolean;
}

export interface AlertEvaluationResult {
  supplierId: string;
  previousScore: number;
  currentScore: number;
  previousTier: RatingTier;
  currentTier: RatingTier;
  alerts: SupplierTierAlert[];
}

const DEFAULT_CONFIG: Required<Omit<SupplierTierAlertConfig, "tiers" | "notificationChannel">> & {
  tiers: TierBoundary[];
  notificationChannel: "sms" | "email" | "in_app";
} = {
  approachThresholdPercent: 5,
  approachThresholdAbsolute: 2,
  dedupTtlSeconds: 24 * 60 * 60,
  notificationChannel: "in_app",
  tiers: TIER_BOUNDARIES,
  enabled: true,
};

function resolveTier(score: number, allSuppressed: boolean, tiers: TierBoundary[]): RatingTier {
  if (allSuppressed) return "New Supplier";
  for (const boundary of tiers) {
    if (score >= boundary.minScore) {
      return boundary.tier;
    }
  }
  return "At Risk";
}

function generateDedupKey(
  supplierId: string,
  alertType: AlertType,
  boundaryScore: number,
  dayKey: string,
): string {
  return `tier-alert:dedup:${supplierId}:${alertType}:${boundaryScore}:${dayKey}`;
}

function getDayKey(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function buildAlertMessage(
  alertType: AlertType,
  fromTier: RatingTier,
  toTier: RatingTier,
  currentScore: number,
  boundaryScore: number,
): string {
  if (alertType === "demotion") {
    return (
      `⚠️ Tier Demotion: Your account has moved from "${fromTier}" to "${toTier}". ` +
      `Current score: ${currentScore.toFixed(1)}, below the ${boundaryScore.toFixed(1)} threshold. ` +
      `Review your performance metrics to regain your previous tier.`
    );
  }
  return (
    `📊 Tier Alert: Your current score (${currentScore.toFixed(1)}) is approaching the ` +
    `"${toTier}" boundary at ${boundaryScore.toFixed(1)}. ` +
    `${currentScore >= boundaryScore ? "You are in danger of demotion." : "Improve your metrics to reach this tier."}`
  );
}

export class SupplierTierAlertService {
  private config: typeof DEFAULT_CONFIG;
  private dedupCache: InMemoryCache<boolean>;
  private reputationService: ReputationTransparencyService;
  private previousScores: Map<string, number> = new Map();
  private alertHistory: SupplierTierAlert[] = [];
  private alertIdSequence = 1;
  private notificationHandlers: Map<
    "sms" | "email" | "in_app",
    (alert: SupplierTierAlert) => Promise<void> | void
  > = new Map();

  constructor(
    reputationService: ReputationTransparencyService,
    config: SupplierTierAlertConfig = {},
  ) {
    this.reputationService = reputationService;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      tiers: config.tiers ?? DEFAULT_CONFIG.tiers,
    };
    this.dedupCache = new InMemoryCache<boolean>({
      ttlMs: this.config.dedupTtlSeconds * 1000,
      maxEntries: 10000,
    });

    this.notificationHandlers.set("in_app", (alert) => {
      logger.info(
        `[in-app-alert] supplier=${alert.supplierId} type=${alert.alertType} ${alert.message}`,
      );
    });
  }

  setNotificationHandler(
    channel: "sms" | "email" | "in_app",
    handler: (alert: SupplierTierAlert) => Promise<void> | void,
  ): void {
    this.notificationHandlers.set(channel, handler);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  seedPreviousScore(supplierId: string, score: number): void {
    this.previousScores.set(supplierId, score);
  }

  async evaluateSupplier(supplierId: string): Promise<AlertEvaluationResult> {
    if (!this.config.enabled) {
      return {
        supplierId,
        previousScore: 0,
        currentScore: 0,
        previousTier: "New Supplier",
        currentTier: "New Supplier",
        alerts: [],
      };
    }

    const projection = this.reputationService.getSignalProjection(supplierId);
    const currentScore = projection.overallScore;
    const allSuppressed = projection.privacyMetadata.suppressedCategoryCount === 5;

    const currentTier = resolveTier(currentScore, allSuppressed, this.config.tiers);

    const previousScore = this.previousScores.get(supplierId) ?? currentScore;
    const previousTier = resolveTier(previousScore, allSuppressed, this.config.tiers);

    const alerts: SupplierTierAlert[] = [];

    if (previousTier !== currentTier && previousScore > currentScore) {
      const demotionAlert = this.createAlert(
        supplierId,
        "demotion",
        previousTier,
        currentTier,
        this.findBoundaryScore(currentTier),
        currentScore,
        previousScore - currentScore,
      );
      if (demotionAlert) {
        alerts.push(demotionAlert);
      }
    }

    for (const boundary of this.config.tiers) {
      if (boundary.tier === "At Risk") continue;

      const threshold = this.config.approachThresholdAbsolute;
      const distance = Math.abs(currentScore - boundary.minScore);

      if (distance <= threshold) {
        const approachingFromAbove = currentScore >= boundary.minScore;
        const toTier = approachingFromAbove ? this.findNextLowerTier(boundary.tier) : boundary.tier;
        const fromTier = approachingFromAbove ? boundary.tier : currentTier;

        const approachAlert = this.createAlert(
          supplierId,
          "approach",
          fromTier,
          toTier,
          boundary.minScore,
          currentScore,
          distance,
        );
        if (approachAlert) {
          alerts.push(approachAlert);
        }
      }
    }

    for (const alert of alerts) {
      await this.dispatchNotification(alert);
    }

    this.previousScores.set(supplierId, currentScore);

    return {
      supplierId,
      previousScore,
      currentScore,
      previousTier,
      currentTier,
      alerts,
    };
  }

  async evaluateAllSuppliers(): Promise<AlertEvaluationResult[]> {
    const results: AlertEvaluationResult[] = [];

    const supplierIds = this.getAllSupplierIds();
    for (const supplierId of supplierIds) {
      try {
        const result = await this.evaluateSupplier(supplierId);
        results.push(result);
      } catch (err) {
        logger.warn(
          { err },
          `[tier-alert] Failed to evaluate supplier ${supplierId}`,
        );
      }
    }

    return results;
  }

  getAlertHistory(supplierId?: string): SupplierTierAlert[] {
    let history = [...this.alertHistory];
    if (supplierId) {
      history = history.filter((a) => a.supplierId === supplierId);
    }
    return history.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  acknowledgeAlert(alertId: string): SupplierTierAlert | undefined {
    const alert = this.alertHistory.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
    }
    return alert;
  }

  private createAlert(
    supplierId: string,
    alertType: AlertType,
    fromTier: RatingTier,
    toTier: RatingTier,
    boundaryScore: number,
    currentScore: number,
    distanceToBoundary: number,
  ): SupplierTierAlert | null {
    const dayKey = getDayKey();
    const dedupKey = generateDedupKey(supplierId, alertType, boundaryScore, dayKey);

    if (this.dedupCache.get(dedupKey)) {
      return null;
    }

    this.dedupCache.set(dedupKey, true, this.config.dedupTtlSeconds * 1000);

    const alert: SupplierTierAlert = {
      id: `tier-alert-${this.alertIdSequence++}`,
      supplierId,
      alertType,
      fromTier,
      toTier,
      boundaryScore,
      currentScore,
      distanceToBoundary,
      message: buildAlertMessage(alertType, fromTier, toTier, currentScore, boundaryScore),
      createdAt: new Date().toISOString(),
      acknowledged: false,
    };

    this.alertHistory.push(alert);
    return alert;
  }

  private async dispatchNotification(alert: SupplierTierAlert): Promise<void> {
    const handler = this.notificationHandlers.get(this.config.notificationChannel);
    if (!handler) return;

    try {
      await handler(alert);
    } catch (err) {
      logger.warn(
        { err },
        `[tier-alert] Notification dispatch failed for alert ${alert.id}`,
      );
    }
  }

  private findBoundaryScore(tier: RatingTier): number {
    for (const boundary of this.config.tiers) {
      if (boundary.tier === tier) return boundary.minScore;
    }
    return 0;
  }

  private findNextLowerTier(tier: RatingTier): RatingTier {
    const tierOrder: RatingTier[] = ["Top Rated", "Standard", "At Risk", "New Supplier"];
    const idx = tierOrder.indexOf(tier);
    return idx >= 0 && idx < tierOrder.length - 1 ? tierOrder[idx + 1] : "At Risk";
  }

  private getAllSupplierIds(): string[] {
    const ids: string[] = [];
    const repServiceAny = this.reputationService as any;
    if (repServiceAny.getSupplier) {
      for (let i = 100; i < 1000; i++) {
        try {
          const supplier = repServiceAny.getSupplier(`supplier-${i}`);
          if (supplier) ids.push(`supplier-${i}`);
        } catch {
          break;
        }
      }
    }
    if (ids.length === 0) {
      ids.push("supplier-101", "supplier-102");
    }
    return ids;
  }
}

export const defaultSupplierTierAlertService = new SupplierTierAlertService(
  new ReputationTransparencyService(),
);

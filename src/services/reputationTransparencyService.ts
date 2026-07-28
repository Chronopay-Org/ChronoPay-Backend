/**
 * Reputation Transparency Service
 *
 * Provides aggregated signal projections, category weights, and privacy-preserving
 * reputation breakdowns for suppliers, with counterparty ID redaction and small-cell suppression.
 */

import { recordReputationQuery, recordSmallCellSuppression } from "../metrics.js";
import {
  ReputationBootstrapService,
  reputationBootstrapService,
  type BootstrapEvaluation,
} from "./reputationBootstrapService.js";

export type SignalCategory =
  | "on_time_delivery"
  | "dispute_rate"
  | "fulfillment_speed"
  | "buyer_ratings"
  | "cancellation_rate";

export interface SignalCategoryMetadata {
  category: SignalCategory;
  name: string;
  weight: number;
  description: string;
}

export const DEFAULT_SIGNAL_CATEGORIES: Record<SignalCategory, SignalCategoryMetadata> = {
  on_time_delivery: {
    category: "on_time_delivery",
    name: "On-Time Delivery Rate",
    weight: 0.30,
    description: "Percentage of orders delivered on or before the committed SLA date",
  },
  dispute_rate: {
    category: "dispute_rate",
    name: "Dispute & Chargeback Rate",
    weight: 0.25,
    description: "Frequency of buyer-initiated disputes, returns, and chargebacks",
  },
  fulfillment_speed: {
    category: "fulfillment_speed",
    name: "Order Processing & Dispatch Speed",
    weight: 0.20,
    description: "Average speed from payment confirmation to carrier dispatch",
  },
  buyer_ratings: {
    category: "buyer_ratings",
    name: "Buyer Satisfaction Rating",
    weight: 0.15,
    description: "Aggregated buyer feedback and rating average across completed orders",
  },
  cancellation_rate: {
    category: "cancellation_rate",
    name: "Order Cancellation Rate",
    weight: 0.10,
    description: "Percentage of supplier-initiated order cancellations",
  },
};

export interface RawCategoryEvaluation {
  category: SignalCategory;
  totalEvaluations: number; // Number of unique counterparty interactions/events
  positiveEvaluations: number;
  score: number; // 0.0 to 100.0
}

export interface SignalCategoryProjection {
  category: SignalCategory;
  name: string;
  weight: number;
  categoryScore: number | null;
  contributionScore: number;
  totalEvaluations: number | null;
  suppressed: boolean;
  suppressionReason?: string;
  status: "excellent" | "good" | "needs_improvement" | "poor" | "insufficient_data";
  recommendation: string;
}

export interface PrivacyMetadata {
  buyerIdsRedacted: boolean;
  smallCellSuppressionActive: boolean;
  minCellSizeThreshold: number;
  suppressedCategoryCount: number;
}

export interface BootstrapMetadata {
  granted: boolean;
  active: boolean;
  scoreContribution: number;
  consumed: boolean;
  expiresAt: string | null;
  decayProgress: number;
  reasonInactive: string | null;
}

export interface ReputationSignalProjectionResponse {
  supplierId: string;
  tenantId: string;
  overallScore: number;
  overallRatingTier: "Top Rated" | "Standard" | "At Risk" | "New Supplier";
  categoryBreakdown: SignalCategoryProjection[];
  privacyMetadata: PrivacyMetadata;
  bootstrap: BootstrapMetadata;
  generatedAt: string;
}

export interface SupplierRecord {
  id: string;
  name: string;
  ownerId: string;
  tenantId: string;
}

export interface ReputationServiceOptions {
  minCellSizeThreshold?: number;
  bootstrapService?: ReputationBootstrapService;
}

export class ReputationTransparencyService {
  private minCellSizeThreshold: number;
  private suppliers: Map<string, SupplierRecord> = new Map();
  private supplierSignals: Map<string, Map<SignalCategory, RawCategoryEvaluation>> = new Map();
  private bootstrap: ReputationBootstrapService;

  constructor(options: ReputationServiceOptions = {}) {
    this.minCellSizeThreshold = options.minCellSizeThreshold ?? 5;
    this.bootstrap = options.bootstrapService ?? reputationBootstrapService;

    // Seed mock/default suppliers for demonstration and tests
    this.seedDefaultSuppliers();
  }

  private seedDefaultSuppliers(): void {
    const defaultSupplier: SupplierRecord = {
      id: "supplier-101",
      name: "Acme Logistics & Components",
      ownerId: "owner-alice",
      tenantId: "tenant-us-east",
    };
    this.registerSupplier(defaultSupplier);

    this.setSupplierEvaluations("supplier-101", [
      { category: "on_time_delivery", totalEvaluations: 45, positiveEvaluations: 42, score: 93.3 },
      { category: "dispute_rate", totalEvaluations: 45, positiveEvaluations: 44, score: 97.8 },
      { category: "fulfillment_speed", totalEvaluations: 40, positiveEvaluations: 36, score: 90.0 },
      { category: "buyer_ratings", totalEvaluations: 12, positiveEvaluations: 11, score: 91.7 },
      { category: "cancellation_rate", totalEvaluations: 3, positiveEvaluations: 3, score: 100.0 }, // Cell size < 5 -> suppressed
    ]);

    const smallSupplier: SupplierRecord = {
      id: "supplier-102",
      name: "Boutique Craft Goods",
      ownerId: "owner-bob",
      tenantId: "tenant-us-east",
    };
    this.registerSupplier(smallSupplier);

    this.setSupplierEvaluations("supplier-102", [
      { category: "on_time_delivery", totalEvaluations: 2, positiveEvaluations: 2, score: 100.0 },
      { category: "dispute_rate", totalEvaluations: 2, positiveEvaluations: 2, score: 100.0 },
      { category: "fulfillment_speed", totalEvaluations: 1, positiveEvaluations: 1, score: 100.0 },
      { category: "buyer_ratings", totalEvaluations: 2, positiveEvaluations: 2, score: 100.0 },
      { category: "cancellation_rate", totalEvaluations: 0, positiveEvaluations: 0, score: 0.0 },
    ]);
  }

  public registerSupplier(supplier: SupplierRecord): void {
    this.suppliers.set(supplier.id, supplier);
    if (!this.supplierSignals.has(supplier.id)) {
      this.supplierSignals.set(supplier.id, new Map());
    }
  }

  public getSupplier(supplierId: string): SupplierRecord | undefined {
    return this.suppliers.get(supplierId);
  }

  public setSupplierEvaluations(supplierId: string, evaluations: RawCategoryEvaluation[]): void {
    const categoryMap = this.supplierSignals.get(supplierId) ?? new Map<SignalCategory, RawCategoryEvaluation>();
    for (const evalItem of evaluations) {
      categoryMap.set(evalItem.category, evalItem);
    }
    this.supplierSignals.set(supplierId, categoryMap);
  }

  /**
   * Verify if the requesting user is the legitimate owner or authorized admin of the supplier
   */
  public verifyOwnership(
    supplierId: string,
    actorUserId: string,
    actorRole?: string,
    actorTenantId?: string
  ): { isAuthorized: boolean; isNotFound: boolean; isForbidden: boolean } {
    const supplier = this.suppliers.get(supplierId);
    if (!supplier) {
      return { isAuthorized: false, isNotFound: true, isForbidden: false };
    }

    // Role admin overrides
    if (actorRole === "admin") {
      return { isAuthorized: true, isNotFound: false, isForbidden: false };
    }

    // Tenant scoping check if tenant ID provided
    if (actorTenantId && supplier.tenantId && actorTenantId !== supplier.tenantId) {
      return { isAuthorized: false, isNotFound: false, isForbidden: true };
    }

    // Owner check
    if (supplier.ownerId === actorUserId) {
      return { isAuthorized: true, isNotFound: false, isForbidden: false };
    }

    return { isAuthorized: false, isNotFound: false, isForbidden: true };
  }

  public getBootstrapService(): ReputationBootstrapService {
    return this.bootstrap;
  }

  /**
   * Projects supplier reputation signals with privacy safeguards:
   * - Redacts raw buyer / counterparty IDs
   * - Suppresses exact counts for small cells (< minCellSizeThreshold)
   */
  public getSignalProjection(supplierId: string): ReputationSignalProjectionResponse {
    const supplier = this.suppliers.get(supplierId);
    if (!supplier) {
      throw new Error(`Supplier with ID ${supplierId} not found.`);
    }

    const rawSignalsMap = this.supplierSignals.get(supplierId) ?? new Map();
    const categories: SignalCategory[] = [
      "on_time_delivery",
      "dispute_rate",
      "fulfillment_speed",
      "buyer_ratings",
      "cancellation_rate",
    ];

    let totalWeightedScoreSum = 0;
    let totalValidWeight = 0;
    let suppressedCategoryCount = 0;

    const categoryBreakdown: SignalCategoryProjection[] = [];

    for (const catKey of categories) {
      const meta = DEFAULT_SIGNAL_CATEGORIES[catKey];
      const raw = rawSignalsMap.get(catKey) ?? {
        category: catKey,
        totalEvaluations: 0,
        positiveEvaluations: 0,
        score: 0.0,
      };

      const isSuppressed = raw.totalEvaluations < this.minCellSizeThreshold;

      if (isSuppressed) {
        suppressedCategoryCount++;
        recordSmallCellSuppression(supplier.tenantId, catKey);

        categoryBreakdown.push({
          category: catKey,
          name: meta.name,
          weight: meta.weight,
          categoryScore: null,
          contributionScore: 0,
          totalEvaluations: null,
          suppressed: true,
          suppressionReason: `Sample size < ${this.minCellSizeThreshold}. Suppressed to protect counterparty privacy.`,
          status: "insufficient_data",
          recommendation: `Fulfill more orders in this category (minimum ${this.minCellSizeThreshold} evaluations required) to view detailed performance metrics.`,
        });
      } else {
        const roundedScore = Math.round(raw.score * 10) / 10;
        const contribution = Math.round(meta.weight * roundedScore * 10) / 10;

        totalWeightedScoreSum += contribution;
        totalValidWeight += meta.weight;

        const status = this.determineCategoryStatus(catKey, roundedScore);
        const recommendation = this.generateRecommendation(catKey, roundedScore);

        categoryBreakdown.push({
          category: catKey,
          name: meta.name,
          weight: meta.weight,
          categoryScore: roundedScore,
          contributionScore: contribution,
          totalEvaluations: raw.totalEvaluations,
          suppressed: false,
          status,
          recommendation,
        });
      }
    }

    const allCategoriesSuppressed = suppressedCategoryCount === categories.length;

    let baseScore: number;
    if (totalValidWeight > 0) {
      baseScore = Math.round((totalWeightedScoreSum / totalValidWeight) * 10) / 10;
    } else {
      baseScore = 0;
    }

    const bootstrapEval: BootstrapEvaluation = this.bootstrap.evaluate(supplierId);

    let overallScore: number;
    if (totalValidWeight > 0) {
      overallScore = baseScore;
    } else if (bootstrapEval.active) {
      overallScore = bootstrapEval.scoreContribution;
    } else {
      overallScore = 70.0;
    }

    const allSuppressedAndNoBootstrap = allCategoriesSuppressed && !bootstrapEval.active;

    const overallRatingTier = this.determineRatingTier(overallScore, allSuppressedAndNoBootstrap);

    recordReputationQuery(supplier.tenantId, "success");

    const bootstrapRecord = this.bootstrap.getRecord(supplierId);
    const bootstrapMeta: BootstrapMetadata = {
      granted: !!bootstrapRecord,
      active: bootstrapEval.active,
      scoreContribution: bootstrapEval.scoreContribution,
      consumed: bootstrapEval.consumed,
      expiresAt: bootstrapEval.expiresAt ? bootstrapEval.expiresAt.toISOString() : null,
      decayProgress: bootstrapEval.decayProgress,
      reasonInactive: bootstrapEval.reasonInactive ?? null,
    };

    return {
      supplierId: supplier.id,
      tenantId: supplier.tenantId,
      overallScore,
      overallRatingTier,
      categoryBreakdown,
      privacyMetadata: {
        buyerIdsRedacted: true,
        smallCellSuppressionActive: true,
        minCellSizeThreshold: this.minCellSizeThreshold,
        suppressedCategoryCount,
      },
      bootstrap: bootstrapMeta,
      generatedAt: new Date().toISOString(),
    };
  }

  private determineCategoryStatus(
    category: SignalCategory,
    score: number
  ): "excellent" | "good" | "needs_improvement" | "poor" | "insufficient_data" {
    if (score >= 90) return "excellent";
    if (score >= 80) return "good";
    if (score >= 70) return "needs_improvement";
    return "poor";
  }

  private generateRecommendation(category: SignalCategory, score: number): string {
    if (score >= 90) {
      return `Outstanding ${category.replace(/_/g, " ")} score. Maintain current operational standards.`;
    }

    switch (category) {
      case "on_time_delivery":
        return "Improve logistics dispatch buffer times to reduce late SLA delivery occurrences.";
      case "dispute_rate":
        return "Enhance product description clarity and pre-shipment quality checks to decrease buyer dispute claims.";
      case "fulfillment_speed":
        return "Automate order processing workflows to shorten the gap between order payment and shipping.";
      case "buyer_ratings":
        return "Promptly communicate with buyers during transit to improve post-delivery satisfaction ratings.";
      case "cancellation_rate":
        return "Maintain accurate real-time inventory levels to prevent out-of-stock cancellation events.";
      default:
        return "Review operational metrics to identify performance optimization opportunities.";
    }
  }

  private determineRatingTier(
    overallScore: number,
    allSuppressed: boolean
  ): "Top Rated" | "Standard" | "At Risk" | "New Supplier" {
    if (allSuppressed) return "New Supplier";
    if (overallScore >= 90) return "Top Rated";
    if (overallScore >= 75) return "Standard";
    return "At Risk";
  }
}

export const reputationTransparencyService = new ReputationTransparencyService();

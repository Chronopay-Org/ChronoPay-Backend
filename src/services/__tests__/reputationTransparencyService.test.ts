import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ReputationTransparencyService,
  DEFAULT_SIGNAL_CATEGORIES,
  type SupplierRecord,
  type RawCategoryEvaluation,
  type SignalCategory,
} from "../reputationTransparencyService.js";

describe("ReputationTransparencyService", () => {
  let service: ReputationTransparencyService;

  beforeEach(() => {
    service = new ReputationTransparencyService({ minCellSizeThreshold: 5 });
  });

  describe("Default Configuration & Categories", () => {
    it("should export correct default signal categories and weights", () => {
      expect(DEFAULT_SIGNAL_CATEGORIES.on_time_delivery.weight).toBe(0.30);
      expect(DEFAULT_SIGNAL_CATEGORIES.dispute_rate.weight).toBe(0.25);
      expect(DEFAULT_SIGNAL_CATEGORIES.fulfillment_speed.weight).toBe(0.20);
      expect(DEFAULT_SIGNAL_CATEGORIES.buyer_ratings.weight).toBe(0.15);
      expect(DEFAULT_SIGNAL_CATEGORIES.cancellation_rate.weight).toBe(0.10);

      const totalWeight = Object.values(DEFAULT_SIGNAL_CATEGORIES).reduce(
        (sum, cat) => sum + cat.weight,
        0
      );
      expect(Math.round(totalWeight * 100) / 100).toBe(1.0);
    });

    it("should allow registering suppliers and retrieving them", () => {
      const newSupplier: SupplierRecord = {
        id: "supplier-test-1",
        name: "Test Supplier",
        ownerId: "owner-test-1",
        tenantId: "tenant-us-west",
      };
      service.registerSupplier(newSupplier);

      const retrieved = service.getSupplier("supplier-test-1");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Test Supplier");
    });
  });

  describe("Ownership & Tenant Scoping Verification", () => {
    const supplier: SupplierRecord = {
      id: "supplier-scoping-1",
      name: "Scoping Supplier",
      ownerId: "legit-owner",
      tenantId: "tenant-alpha",
    };

    beforeEach(() => {
      service.registerSupplier(supplier);
    });

    it("should authorize the legitimate owner", () => {
      const result = service.verifyOwnership("supplier-scoping-1", "legit-owner");
      expect(result.isAuthorized).toBe(true);
      expect(result.isNotFound).toBe(false);
      expect(result.isForbidden).toBe(false);
    });

    it("should deny an imposter user (owner impersonation)", () => {
      const result = service.verifyOwnership("supplier-scoping-1", "hacker-user");
      expect(result.isAuthorized).toBe(false);
      expect(result.isNotFound).toBe(false);
      expect(result.isForbidden).toBe(true);
    });

    it("should allow admin role override regardless of ownerId", () => {
      const result = service.verifyOwnership("supplier-scoping-1", "admin-user", "admin");
      expect(result.isAuthorized).toBe(true);
      expect(result.isNotFound).toBe(false);
      expect(result.isForbidden).toBe(false);
    });

    it("should reject cross-tenant requests", () => {
      const result = service.verifyOwnership("supplier-scoping-1", "legit-owner", "user", "tenant-beta");
      expect(result.isAuthorized).toBe(false);
      expect(result.isForbidden).toBe(true);
    });

    it("should return isNotFound for non-existent supplier ID", () => {
      const result = service.verifyOwnership("unknown-supplier", "legit-owner");
      expect(result.isNotFound).toBe(true);
      expect(result.isAuthorized).toBe(false);
    });
  });

  describe("Aggregated Signal Projection & Calculations", () => {
    it("should compute overall reputation score and category breakdowns accurately", () => {
      const supplier: SupplierRecord = {
        id: "supplier-calc-1",
        name: "Calculation Supplier",
        ownerId: "owner-calc",
        tenantId: "tenant-calc",
      };
      service.registerSupplier(supplier);

      const evaluations: RawCategoryEvaluation[] = [
        { category: "on_time_delivery", totalEvaluations: 50, positiveEvaluations: 45, score: 90.0 },
        { category: "dispute_rate", totalEvaluations: 50, positiveEvaluations: 48, score: 96.0 },
        { category: "fulfillment_speed", totalEvaluations: 50, positiveEvaluations: 42, score: 84.0 },
        { category: "buyer_ratings", totalEvaluations: 50, positiveEvaluations: 45, score: 90.0 },
        { category: "cancellation_rate", totalEvaluations: 50, positiveEvaluations: 50, score: 100.0 },
      ];
      service.setSupplierEvaluations("supplier-calc-1", evaluations);

      const projection = service.getSignalProjection("supplier-calc-1");

      expect(projection.supplierId).toBe("supplier-calc-1");
      expect(projection.overallRatingTier).toBe("Top Rated");
      expect(projection.privacyMetadata.suppressedCategoryCount).toBe(0);

      // Category breakdown checks
      const onTime = projection.categoryBreakdown.find((c) => c.category === "on_time_delivery");
      expect(onTime?.categoryScore).toBe(90.0);
      expect(onTime?.contributionScore).toBe(27.0); // 0.30 * 90.0
      expect(onTime?.suppressed).toBe(false);
    });

    it("should generate category-specific recommendations for low scores across all categories", () => {
      const supplierLow: SupplierRecord = {
        id: "supplier-low-all",
        name: "Low Score Supplier",
        ownerId: "owner-low",
        tenantId: "tenant-low",
      };
      service.registerSupplier(supplierLow);

      const categories: SignalCategory[] = [
        "on_time_delivery",
        "dispute_rate",
        "fulfillment_speed",
        "buyer_ratings",
        "cancellation_rate",
      ];

      const lowEvaluations: RawCategoryEvaluation[] = categories.map((cat) => ({
        category: cat,
        totalEvaluations: 10,
        positiveEvaluations: 5,
        score: 65.0, // Needs improvement / poor
      }));
      service.setSupplierEvaluations("supplier-low-all", lowEvaluations);

      const projection = service.getSignalProjection("supplier-low-all");
      expect(projection.overallRatingTier).toBe("At Risk");

      for (const cat of categories) {
        const item = projection.categoryBreakdown.find((c) => c.category === cat);
        expect(item?.status).toBe("poor");
        expect(item?.recommendation).toBeDefined();
        expect(item?.recommendation.length).toBeGreaterThan(10);
      }
    });

    it("should assign Standard rating tier for scores between 75 and 89", () => {
      const supplierStandard: SupplierRecord = {
        id: "supplier-standard",
        name: "Standard Supplier",
        ownerId: "owner-std",
        tenantId: "tenant-std",
      };
      service.registerSupplier(supplierStandard);

      service.setSupplierEvaluations("supplier-standard", [
        { category: "on_time_delivery", totalEvaluations: 20, positiveEvaluations: 16, score: 80.0 },
        { category: "dispute_rate", totalEvaluations: 20, positiveEvaluations: 16, score: 80.0 },
        { category: "fulfillment_speed", totalEvaluations: 20, positiveEvaluations: 16, score: 80.0 },
        { category: "buyer_ratings", totalEvaluations: 20, positiveEvaluations: 16, score: 80.0 },
        { category: "cancellation_rate", totalEvaluations: 20, positiveEvaluations: 16, score: 80.0 },
      ]);

      const projection = service.getSignalProjection("supplier-standard");
      expect(projection.overallRatingTier).toBe("Standard");
    });
  });

  describe("Privacy & Small-Cell Suppression", () => {
    it("should redact raw buyer counterparty IDs from projection response", () => {
      const projection = service.getSignalProjection("supplier-101");
      const jsonString = JSON.stringify(projection);

      expect(jsonString).not.toMatch(/"buyer_?id"\s*:/i);
      expect(jsonString).not.toMatch(/"counterparty_?id"\s*:/i);
      expect(projection.privacyMetadata.buyerIdsRedacted).toBe(true);
    });

    it("should suppress exact counts and scores when evaluation sample size < minCellSizeThreshold (5)", () => {
      const supplier: SupplierRecord = {
        id: "supplier-privacy-1",
        name: "Privacy Supplier",
        ownerId: "owner-priv",
        tenantId: "tenant-priv",
      };
      service.registerSupplier(supplier);

      service.setSupplierEvaluations("supplier-privacy-1", [
        { category: "on_time_delivery", totalEvaluations: 10, positiveEvaluations: 10, score: 100.0 },
        { category: "cancellation_rate", totalEvaluations: 4, positiveEvaluations: 4, score: 100.0 }, // 4 < 5 -> Suppressed
      ]);

      const projection = service.getSignalProjection("supplier-privacy-1");

      const cancellation = projection.categoryBreakdown.find((c) => c.category === "cancellation_rate");
      expect(cancellation?.suppressed).toBe(true);
      expect(cancellation?.totalEvaluations).toBeNull();
      expect(cancellation?.categoryScore).toBeNull();
      expect(cancellation?.contributionScore).toBe(0);
      expect(cancellation?.status).toBe("insufficient_data");
      expect(cancellation?.suppressionReason).toContain("Sample size < 5");
    });

    it("should NOT suppress cell when totalEvaluations exactly equals threshold (5)", () => {
      const supplier: SupplierRecord = {
        id: "supplier-threshold-5",
        name: "Threshold Supplier",
        ownerId: "owner-thresh",
        tenantId: "tenant-thresh",
      };
      service.registerSupplier(supplier);

      service.setSupplierEvaluations("supplier-threshold-5", [
        { category: "dispute_rate", totalEvaluations: 5, positiveEvaluations: 5, score: 100.0 },
      ]);

      const projection = service.getSignalProjection("supplier-threshold-5");
      const dispute = projection.categoryBreakdown.find((c) => c.category === "dispute_rate");

      expect(dispute?.suppressed).toBe(false);
      expect(dispute?.totalEvaluations).toBe(5);
      expect(dispute?.categoryScore).toBe(100.0);
    });

    it("should classify a supplier with all categories suppressed as 'New Supplier'", () => {
      const projection = service.getSignalProjection("supplier-102");
      expect(projection.overallRatingTier).toBe("New Supplier");
      expect(projection.privacyMetadata.suppressedCategoryCount).toBe(5);
    });

    it("should throw an error when querying a non-existent supplier", () => {
      expect(() => service.getSignalProjection("non-existent-id")).toThrow(
        "Supplier with ID non-existent-id not found."
      );
    });
  });
});

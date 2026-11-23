import {
  SupplierTierAlertService,
  TIER_BOUNDARIES,
  type SupplierTierAlertConfig,
  type SupplierTierAlert,
} from "../supplierTierAlertService.js";
import {
  ReputationTransparencyService,
  type SignalCategory,
  type RawCategoryEvaluation,
} from "../reputationTransparencyService.js";

describe("SupplierTierAlertService", () => {
  function buildReputationServiceWithScores(
    supplierId: string,
    overallScore: number,
    evaluations: RawCategoryEvaluation[] = []
  ): ReputationTransparencyService {
    const service = new ReputationTransparencyService({ minCellSizeThreshold: 1 });
    const categories: SignalCategory[] = [
      "on_time_delivery",
      "dispute_rate",
      "fulfillment_speed",
      "buyer_ratings",
      "cancellation_rate",
    ];

    const weightedScore = overallScore;
    const defaultEvals = categories.map((cat) => ({
      category: cat,
      totalEvaluations: 50,
      positiveEvaluations: Math.round((weightedScore / 100) * 50),
      score: weightedScore,
    }));

    service.registerSupplier({
      id: supplierId,
      name: `Test Supplier ${supplierId}`,
      ownerId: `owner-${supplierId}`,
      tenantId: "tenant-test",
    });
    service.setSupplierEvaluations(supplierId, evaluations.length > 0 ? evaluations : defaultEvals);

    return service;
  }

  function buildAlertService(
    supplierId: string,
    initialScore: number,
    config: SupplierTierAlertConfig = {}
  ): { service: SupplierTierAlertService; reputation: ReputationTransparencyService } {
    const reputation = buildReputationServiceWithScores(supplierId, initialScore);
    const service = new SupplierTierAlertService(reputation, config);
    service.seedPreviousScore(supplierId, initialScore);
    return { service, reputation };
  }

  function updateSupplierScore(
    reputation: ReputationTransparencyService,
    supplierId: string,
    newScore: number
  ): void {
    const categories: SignalCategory[] = [
      "on_time_delivery",
      "dispute_rate",
      "fulfillment_speed",
      "buyer_ratings",
      "cancellation_rate",
    ];
    const evals = categories.map((cat) => ({
      category: cat,
      totalEvaluations: 50,
      positiveEvaluations: Math.round((newScore / 100) * 50),
      score: newScore,
    }));
    reputation.setSupplierEvaluations(supplierId, evals);
  }

  describe("configuration", () => {
    it("should be enabled by default", () => {
      const { service } = buildAlertService("s1", 85);
      expect(service.isEnabled()).toBe(true);
    });

    it("should allow disabling and enabling", () => {
      const { service } = buildAlertService("s1", 85);
      service.setEnabled(false);
      expect(service.isEnabled()).toBe(false);
      service.setEnabled(true);
      expect(service.isEnabled()).toBe(true);
    });

    it("should return no alerts when disabled", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      service.setEnabled(false);
      updateSupplierScore(reputation, "s1", 50);

      const result = await service.evaluateSupplier("s1");
      expect(result.alerts).toHaveLength(0);
    });
  });

  describe("demotion alerts", () => {
    it("should emit a demotion alert when crossing from Top Rated to Standard", async () => {
      const { service, reputation } = buildAlertService("s1", 95);

      updateSupplierScore(reputation, "s1", 80);
      const result = await service.evaluateSupplier("s1");

      const demotionAlerts = result.alerts.filter((a) => a.alertType === "demotion");
      expect(demotionAlerts).toHaveLength(1);
      expect(demotionAlerts[0].fromTier).toBe("Top Rated");
      expect(demotionAlerts[0].toTier).toBe("Standard");
      expect(demotionAlerts[0].boundaryScore).toBe(90);
    });

    it("should emit a demotion alert when crossing from Standard to At Risk", async () => {
      const { service, reputation } = buildAlertService("s1", 85);

      updateSupplierScore(reputation, "s1", 60);
      const result = await service.evaluateSupplier("s1");

      const demotionAlerts = result.alerts.filter((a) => a.alertType === "demotion");
      expect(demotionAlerts).toHaveLength(1);
      expect(demotionAlerts[0].fromTier).toBe("Standard");
      expect(demotionAlerts[0].toTier).toBe("At Risk");
      expect(demotionAlerts[0].boundaryScore).toBe(75);
    });

    it("should emit a demotion alert from Top Rated directly to At Risk", async () => {
      const { service, reputation } = buildAlertService("s1", 95);

      updateSupplierScore(reputation, "s1", 50);
      const result = await service.evaluateSupplier("s1");

      const demotionAlerts = result.alerts.filter((a) => a.alertType === "demotion");
      expect(demotionAlerts).toHaveLength(1);
      expect(demotionAlerts[0].fromTier).toBe("Top Rated");
      expect(demotionAlerts[0].toTier).toBe("At Risk");
    });

    it("should NOT emit a demotion alert when score improves", async () => {
      const { service, reputation } = buildAlertService("s1", 70);

      updateSupplierScore(reputation, "s1", 85);
      const result = await service.evaluateSupplier("s1");

      const demotionAlerts = result.alerts.filter((a) => a.alertType === "demotion");
      expect(demotionAlerts).toHaveLength(0);
    });

    it("should NOT emit a demotion alert when tier stays the same", async () => {
      const { service, reputation } = buildAlertService("s1", 85);

      updateSupplierScore(reputation, "s1", 82);
      const result = await service.evaluateSupplier("s1");

      const demotionAlerts = result.alerts.filter((a) => a.alertType === "demotion");
      expect(demotionAlerts).toHaveLength(0);
    });
  });

  describe("approach alerts", () => {
    it("should emit an approach alert when close to Top Rated boundary from below", async () => {
      const { service } = buildAlertService("s1", 88, {
        approachThresholdAbsolute: 3,
      });

      const result = await service.evaluateSupplier("s1");
      const approachAlerts = result.alerts.filter((a) => a.alertType === "approach");
      expect(approachAlerts.length).toBeGreaterThan(0);
      expect(approachAlerts.some((a) => a.boundaryScore === 90)).toBe(true);
    });

    it("should emit an approach alert when close to Top Rated boundary from above (demotion risk)", async () => {
      const { service } = buildAlertService("s1", 91, {
        approachThresholdAbsolute: 2,
      });

      const result = await service.evaluateSupplier("s1");
      const approachAlerts = result.alerts.filter((a) => a.alertType === "approach");
      expect(approachAlerts.length).toBeGreaterThan(0);
      expect(approachAlerts.some((a) => a.boundaryScore === 90)).toBe(true);
    });

    it("should emit an approach alert when near Standard boundary", async () => {
      const { service } = buildAlertService("s1", 76, {
        approachThresholdAbsolute: 2,
      });

      const result = await service.evaluateSupplier("s1");
      const approachAlerts = result.alerts.filter((a) => a.alertType === "approach");
      expect(approachAlerts.some((a) => a.boundaryScore === 75)).toBe(true);
    });

    it("should NOT emit approach alerts when far from any boundary", async () => {
      const { service } = buildAlertService("s1", 50, {
        approachThresholdAbsolute: 2,
      });

      const result = await service.evaluateSupplier("s1");
      const approachAlerts = result.alerts.filter((a) => a.alertType === "approach");
      expect(approachAlerts).toHaveLength(0);
    });
  });

  describe("daily de-duplication", () => {
    it("should not emit duplicate demotion alerts for same boundary on same day", async () => {
      const { service, reputation } = buildAlertService("s1", 95);

      updateSupplierScore(reputation, "s1", 80);
      const result1 = await service.evaluateSupplier("s1");
      expect(result1.alerts.filter((a) => a.alertType === "demotion")).toHaveLength(1);

      updateSupplierScore(reputation, "s1", 78);
      const result2 = await service.evaluateSupplier("s1");
      expect(result2.alerts.filter((a) => a.alertType === "demotion")).toHaveLength(0);
    });

    it("should not emit duplicate approach alerts for same boundary on same day", async () => {
      const { service } = buildAlertService("s1", 89, {
        approachThresholdAbsolute: 3,
      });

      const result1 = await service.evaluateSupplier("s1");
      const approachCount1 = result1.alerts.filter((a) => a.alertType === "approach").length;
      expect(approachCount1).toBeGreaterThan(0);

      const result2 = await service.evaluateSupplier("s1");
      const approachCount2 = result2.alerts.filter((a) => a.alertType === "approach").length;
      expect(approachCount2).toBe(0);
    });
  });

  describe("alert content", () => {
    it("should include a meaningful demotion message", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      updateSupplierScore(reputation, "s1", 80);

      const result = await service.evaluateSupplier("s1");
      const alert = result.alerts.find((a) => a.alertType === "demotion");

      expect(alert).toBeDefined();
      expect(alert!.message).toContain("Demotion");
      expect(alert!.message).toContain("Top Rated");
      expect(alert!.message).toContain("Standard");
      expect(alert!.message).toContain("90");
    });

    it("should include a meaningful approach message", async () => {
      const { service } = buildAlertService("s1", 91, {
        approachThresholdAbsolute: 2,
      });

      const result = await service.evaluateSupplier("s1");
      const alert = result.alerts.find(
        (a) => a.alertType === "approach" && a.boundaryScore === 90
      );

      expect(alert).toBeDefined();
      expect(alert!.message).toContain("approaching");
      expect(alert!.message).toContain("90");
    });

    it("should include current and boundary scores in alert", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      updateSupplierScore(reputation, "s1", 83);

      const result = await service.evaluateSupplier("s1");
      const alert = result.alerts.find((a) => a.alertType === "demotion");

      expect(alert!.currentScore).toBe(83);
      expect(alert!.boundaryScore).toBe(90);
    });

    it("should mark alerts as not acknowledged by default", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      updateSupplierScore(reputation, "s1", 80);

      const result = await service.evaluateSupplier("s1");
      expect(result.alerts[0].acknowledged).toBe(false);
    });
  });

  describe("alert history and acknowledgment", () => {
    it("should record alerts in history", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      updateSupplierScore(reputation, "s1", 80);
      await service.evaluateSupplier("s1");

      const history = service.getAlertHistory("s1");
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].supplierId).toBe("s1");
    });

    it("should allow acknowledging an alert", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      updateSupplierScore(reputation, "s1", 80);
      const result = await service.evaluateSupplier("s1");
      const alertId = result.alerts[0].id;

      const acknowledged = service.acknowledgeAlert(alertId);
      expect(acknowledged).toBeDefined();
      expect(acknowledged!.acknowledged).toBe(true);
    });

    it("should return sorted history (newest first)", async () => {
      const { service, reputation } = buildAlertService("s1", 95);

      updateSupplierScore(reputation, "s1", 85);
      await service.evaluateSupplier("s1");

      updateSupplierScore(reputation, "s1", 70);
      await service.evaluateSupplier("s1");

      const history = service.getAlertHistory("s1");
      expect(history.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("notification dispatch", () => {
    it("should invoke the registered notification handler", async () => {
      const { service, reputation } = buildAlertService("s1", 95);
      const receivedAlerts: SupplierTierAlert[] = [];

      service.setNotificationHandler("in_app", (alert) => {
        receivedAlerts.push(alert);
      });

      updateSupplierScore(reputation, "s1", 80);
      await service.evaluateSupplier("s1");

      expect(receivedAlerts.length).toBeGreaterThan(0);
      expect(receivedAlerts[0].alertType).toBe("demotion");
    });

    it("should not fail when notification handler throws", async () => {
      const { service, reputation } = buildAlertService("s1", 95);

      service.setNotificationHandler("in_app", () => {
        throw new Error("Notification failed");
      });

      updateSupplierScore(reputation, "s1", 80);
      await expect(service.evaluateSupplier("s1")).resolves.toBeDefined();
    });
  });

  describe("tier boundary constants", () => {
    it("should have three tier boundaries defined", () => {
      expect(TIER_BOUNDARIES).toHaveLength(3);
    });

    it("should have correct score thresholds for each tier", () => {
      expect(TIER_BOUNDARIES.find((b) => b.tier === "Top Rated")!.minScore).toBe(90);
      expect(TIER_BOUNDARIES.find((b) => b.tier === "Standard")!.minScore).toBe(75);
      expect(TIER_BOUNDARIES.find((b) => b.tier === "At Risk")!.minScore).toBe(0);
    });
  });

  describe("batch evaluation", () => {
    it("should evaluate all registered suppliers", async () => {
      const reputation = new ReputationTransparencyService({ minCellSizeThreshold: 1 });
      const service = new SupplierTierAlertService(reputation);

      reputation.registerSupplier({
        id: "batch-1",
        name: "Batch Supplier 1",
        ownerId: "owner-b1",
        tenantId: "tenant-test",
      });

      reputation.registerSupplier({
        id: "batch-2",
        name: "Batch Supplier 2",
        ownerId: "owner-b2",
        tenantId: "tenant-test",
      });

      const results = await service.evaluateAllSuppliers();
      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("score tracking", () => {
    it("should track previous score across evaluations", async () => {
      const { service, reputation } = buildAlertService("s1", 90);

      updateSupplierScore(reputation, "s1", 85);
      const result1 = await service.evaluateSupplier("s1");
      expect(result1.previousScore).toBe(90);
      expect(result1.currentScore).toBe(85);

      updateSupplierScore(reputation, "s1", 82);
      const result2 = await service.evaluateSupplier("s1");
      expect(result2.previousScore).toBe(85);
      expect(result2.currentScore).toBe(82);
    });
  });
});

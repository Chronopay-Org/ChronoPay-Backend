import { StrikeService, strikeService } from "../strikeService.js";

describe("StrikeService Unit Tests", () => {
  let service: StrikeService;

  beforeEach(() => {
    service = new StrikeService();
    strikeService.resetState();
  });

  describe("Configuration", () => {
    it("should initialize with default configuration", () => {
      const config = service.getConfig();
      expect(config.maxStrikesThreshold).toBe(3);
      expect(config.decayWindowMs).toBe(30 * 24 * 60 * 60 * 1000);
      expect(config.autoSuspendEnabled).toBe(true);
    });

    it("should update configuration with valid values", () => {
      const updated = service.updateConfig({ maxStrikesThreshold: 5, decayWindowMs: 7 * 24 * 60 * 60 * 1000 });
      expect(updated.maxStrikesThreshold).toBe(5);
      expect(updated.decayWindowMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should throw on invalid configuration updates", () => {
      expect(() => service.updateConfig({ maxStrikesThreshold: 0 })).toThrow("maxStrikesThreshold must be a positive integer");
      expect(() => service.updateConfig({ decayWindowMs: -100 })).toThrow("decayWindowMs must be a positive number");
    });
  });

  describe("Strike Issuance & Auto-Suspension", () => {
    it("should throw an error if buyerId is empty", async () => {
      await expect(service.issueStrike({ buyerId: "" })).rejects.toThrow("buyerId is required");
    });

    it("should issue a strike and increment active strike count", async () => {
      const buyerId = "buyer-1";
      const { strike, autoSuspended } = await service.issueStrike({
        buyerId,
        reason: "Missed appointment",
        intentId: "intent-101",
        slotId: "slot-202",
      });

      expect(strike.id).toBeDefined();
      expect(strike.buyerId).toBe(buyerId);
      expect(strike.status).toBe("active");
      expect(autoSuspended).toBe(false);

      const activeStrikes = service.getActiveStrikes(buyerId);
      expect(activeStrikes.length).toBe(1);
      expect(activeStrikes[0].id).toBe(strike.id);
    });

    it("should trigger auto-suspension when reaching max strikes threshold", async () => {
      const buyerId = "buyer-threshold-test";
      const t0 = 1000000;

      // Strike 1
      const res1 = await service.issueStrike({ buyerId, issuedAt: t0 });
      expect(res1.autoSuspended).toBe(false);

      // Strike 2
      const res2 = await service.issueStrike({ buyerId, issuedAt: t0 + 1000 });
      expect(res2.autoSuspended).toBe(false);

      // Strike 3 (threshold reached!)
      const res3 = await service.issueStrike({ buyerId, issuedAt: t0 + 2000 });
      expect(res3.autoSuspended).toBe(true);
      expect(res3.buyerSuspension.isSuspended).toBe(true);
      expect(res3.buyerSuspension.activeStrikesAtSuspension).toBe(3);

      // Strike 4 while already suspended
      const res4 = await service.issueStrike({ buyerId, issuedAt: t0 + 3000 });
      expect(res4.autoSuspended).toBe(false); // Already suspended
      expect(res4.buyerSuspension.isSuspended).toBe(true);
    });
  });

  describe("Decay Policy & Boundaries", () => {
    it("should decay strikes after decayWindowMs has elapsed (exact boundary tests)", async () => {
      const buyerId = "buyer-decay-test";
      const decayMs = 10000; // 10 seconds decay for test
      service.updateConfig({ decayWindowMs: decayMs });

      const t0 = 1000;

      await service.issueStrike({ buyerId, issuedAt: t0 });

      // Before decay boundary (t0 + 9999ms): Active
      expect(service.getActiveStrikes(buyerId, t0 + 9999).length).toBe(1);

      // At exact decay boundary (t0 + 10000ms): Expired / Decayed
      expect(service.getActiveStrikes(buyerId, t0 + 10000).length).toBe(0);

      // After decay boundary (t0 + 10001ms): Expired / Decayed
      expect(service.getActiveStrikes(buyerId, t0 + 10001).length).toBe(0);

      // Total strikes recorded maintains historical decay status
      const allStrikes = service.getBuyerStrikes(buyerId, t0 + 10000);
      expect(allStrikes[0].status).toBe("decayed");
    });

    it("should not trigger suspension if old strikes have decayed below threshold", async () => {
      const buyerId = "buyer-decay-suspension";
      const decayMs = 5000;
      service.updateConfig({ decayWindowMs: decayMs, maxStrikesThreshold: 3 });

      const t0 = 1000;
      await service.issueStrike({ buyerId, issuedAt: t0 });
      await service.issueStrike({ buyerId, issuedAt: t0 + 1000 });

      // Fast forward past decay window for strike 1 and 2
      const t1 = t0 + 6000; // strikes 1 & 2 have decayed

      // Issue new strike
      const res = await service.issueStrike({ buyerId, issuedAt: t1 });

      expect(res.autoSuspended).toBe(false);
      expect(service.getActiveStrikes(buyerId, t1).length).toBe(1);
    });
  });

  describe("Appeal Path & Suspension Reversal", () => {
    it("should fail to appeal non-existent or inactive strike", async () => {
      await expect(service.appealStrike("non-existent", "reason")).rejects.toThrow("not found");
      await expect(service.appealStrike("", "reason")).rejects.toThrow("strikeId is required");
      await expect(service.appealStrike("s1", "")).rejects.toThrow("appealReason is required");
    });

    it("should appeal a strike and reverse account suspension if active strikes fall below threshold", async () => {
      const buyerId = "buyer-appeal-test";
      service.updateConfig({ maxStrikesThreshold: 3 });

      const t0 = 1000;
      await service.issueStrike({ buyerId, issuedAt: t0 });
      await service.issueStrike({ buyerId, issuedAt: t0 + 100 });
      const s3 = await service.issueStrike({ buyerId, issuedAt: t0 + 200 });

      expect(s3.buyerSuspension.isSuspended).toBe(true);

      // Appeal strike 3
      const appealRes = await service.appealStrike(s3.strike.id, "Medical emergency justification", t0 + 500);

      expect(appealRes.strike.status).toBe("appealed");
      expect(appealRes.strike.appealReason).toBe("Medical emergency justification");
      expect(appealRes.suspensionLifted).toBe(true);
      expect(appealRes.buyerSuspension.isSuspended).toBe(false);

      // Active strikes count is now 2
      expect(service.getActiveStrikes(buyerId, t0 + 500).length).toBe(2);

      // Attempting to appeal already appealed strike throws error
      await expect(service.appealStrike(s3.strike.id, "Another appeal", t0 + 600)).rejects.toThrow("is not active");
    });
  });

  describe("Admin Reinstatement Workflow", () => {
    it("should allow admin to reinstate suspended buyer and clear active strikes", async () => {
      const buyerId = "buyer-reinstate-test";
      const t0 = 1000;

      await service.issueStrike({ buyerId, issuedAt: t0 });
      await service.issueStrike({ buyerId, issuedAt: t0 + 10 });
      await service.issueStrike({ buyerId, issuedAt: t0 + 20 });

      const statusBefore = service.getBuyerSuspensionStatus(buyerId, t0 + 30);
      expect(statusBefore.isSuspended).toBe(true);

      const reinstateRes = await service.reinstateBuyer(
        buyerId,
        { adminId: "admin-42", reason: "Good faith exception", clearActiveStrikes: true },
        t0 + 100
      );

      expect(reinstateRes.buyerSuspension.isSuspended).toBe(false);
      expect(reinstateRes.buyerSuspension.reinstatedBy).toBe("admin-42");
      expect(reinstateRes.rescindedStrikesCount).toBe(3);

      const activeAfter = service.getActiveStrikes(buyerId, t0 + 100);
      expect(activeAfter.length).toBe(0);
    });

    it("should throw error if buyerId is empty on reinstatement", async () => {
      await expect(service.reinstateBuyer("")).rejects.toThrow("buyerId is required");
    });
  });

  describe("Edge Case: Simultaneous Strikes (Concurrency)", () => {
    it("should handle simultaneous rapid strikes without race conditions", async () => {
      const buyerId = "buyer-simultaneous-strikes";
      service.updateConfig({ maxStrikesThreshold: 3 });

      // Trigger 5 simultaneous strikes asynchronously
      const promises = Array.from({ length: 5 }).map((_, i) =>
        service.issueStrike({ buyerId, reason: `Concurrent strike ${i}` })
      );

      const results = await Promise.all(promises);

      expect(results.length).toBe(5);
      const suspensionStatus = service.getBuyerSuspensionStatus(buyerId);

      expect(suspensionStatus.isSuspended).toBe(true);
      expect(suspensionStatus.activeStrikesCount).toBe(5);
    });
  });
});

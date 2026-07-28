import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Mock the pg pool module
const mockQuery = jest.fn() as any;
jest.unstable_mockModule("../../db/pool.js", () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

const { PartnerTokenSoftLimitService } = await import("../partnerTokenSoftLimitService.js");

describe("PartnerTokenSoftLimitService", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("computeThreshold", () => {
    it("returns breached=true when usage meets or exceeds soft limit", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(80, 100, 0.8);
      expect(result.breached).toBe(true);
      expect(result.thresholdPct).toBe(0.8);
    });

    it("returns breached=true when usage exceeds soft limit", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(90, 100, 0.8);
      expect(result.breached).toBe(true);
      expect(result.thresholdPct).toBe(0.9);
    });

    it("returns breached=false when usage is below soft limit", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(50, 100, 0.8);
      expect(result.breached).toBe(false);
      expect(result.thresholdPct).toBe(0.5);
    });

    it("returns breached=false when hard cutoff is zero or negative", () => {
      expect(PartnerTokenSoftLimitService.computeThreshold(50, 0, 0.8).breached).toBe(false);
      expect(PartnerTokenSoftLimitService.computeThreshold(50, -1, 0.8).breached).toBe(false);
    });

    it("returns thresholdPct=0 when hard cutoff is zero", () => {
      expect(PartnerTokenSoftLimitService.computeThreshold(50, 0, 0.8).thresholdPct).toBe(0);
    });
  });

  describe("dedupeKey", () => {
    it("produces a stable key for the same partner and window", () => {
      const key1 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85);
      const key2 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85);
      expect(key1).toBe(key2);
    });

    it("produces different keys for different partners", () => {
      const key1 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85);
      const key2 = PartnerTokenSoftLimitService.dedupeKey("partner-2", 0.85);
      expect(key1).not.toBe(key2);
    });

    it("rounds threshold to integer percentage", () => {
      const key = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.856);
      expect(key).toContain(":86:");
    });
  });

  describe("upsertConfig", () => {
    it("throws if softLimit is out of range", async () => {
      await expect(
        PartnerTokenSoftLimitService.upsertConfig("p1", "https://hook.example.com", 0),
      ).rejects.toThrow("softLimit must be in the range");
      await expect(
        PartnerTokenSoftLimitService.upsertConfig("p1", "https://hook.example.com", 1.5),
      ).rejects.toThrow("softLimit must be in the range");
    });

    it("throws if webhookUrl is empty", async () => {
      await expect(
        PartnerTokenSoftLimitService.upsertConfig("p1", ""),
      ).rejects.toThrow("webhookUrl is required");
    });

    it("performs upsert query when valid", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });
      await PartnerTokenSoftLimitService.upsertConfig("p1", "https://hook.example.com", 0.85);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain("INSERT INTO partner_token_soft_limit_config");
      expect(call[0]).toContain("ON CONFLICT");
      expect(call[1]).toEqual(["p1", 0.85, "https://hook.example.com"]);
    });
  });

  describe("getConfig", () => {
    it("returns null when no config exists", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      const config = await PartnerTokenSoftLimitService.getConfig("unknown");
      expect(config).toBeNull();
    });

    it("returns parsed config when found", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [{ partner_id: "p1", soft_limit: 0.8, webhook_url: "https://hook.example.com" }],
      });
      const config = await PartnerTokenSoftLimitService.getConfig("p1");
      expect(config).toEqual({
        partnerId: "p1",
        softLimit: 0.8,
        webhookUrl: "https://hook.example.com",
      });
    });
  });

  describe("enqueueWarning", () => {
    it("inserts a ledger entry and returns it", async () => {
      const fakeRow = {
        id: "uuid-1",
        partner_id: "p1",
        token_usage: 85,
        soft_limit: 0.8,
        threshold_pct: 0.85,
        webhook_url: "https://hook.example.com",
        status: "pending",
        acked_at: null,
        dedupe_key: "p1:85:123",
        created_at: new Date(),
      };
      mockQuery.mockResolvedValue({ rows: [fakeRow] });

      const entry = await PartnerTokenSoftLimitService.enqueueWarning("p1", 85, 0.85, "https://hook.example.com", 0.8);
      expect(entry).not.toBeNull();
      expect(entry!.partnerId).toBe("p1");
      expect(entry!.status).toBe("pending");
    });

    it("returns null on duplicate (unique_violation)", async () => {
      const pgError: any = new Error("duplicate key");
      pgError.code = "23505";
      mockQuery.mockRejectedValue(pgError);

      const entry = await PartnerTokenSoftLimitService.enqueueWarning("p1", 85, 0.85, "https://hook.example.com", 0.8);
      expect(entry).toBeNull();
    });
  });
});

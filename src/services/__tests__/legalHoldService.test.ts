import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockQuery = jest.fn() as jest.MockedFunction<any>;
jest.unstable_mockModule("../../db/pool.js", () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

const { LegalHoldService } = await import("../legalHoldService.js");

describe("LegalHoldService", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  // ─── addHold ───────────────────────────────────────────────────────────────

  describe("addHold", () => {
    it("inserts with correct SQL parameter order ($1 subjectId, $2 actor, $3 reason, $4 region)", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await LegalHoldService.addHold("user-42", "admin@example.com", "fraud investigation", "GDPR");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
      expect(sql).toMatch(/INSERT INTO legal_holds/i);
      expect(params).toEqual(["user-42", "admin@example.com", "fraud investigation", "GDPR"]);
    });

    it("defaults region to EEA when no region argument is supplied", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await LegalHoldService.addHold("user-99", "ops-bot", "data preservation");

      const [, params] = mockQuery.mock.calls[0] as [string, string[]];
      expect(params[3]).toBe("EEA");
    });

    it("passes an explicit region through as $4 instead of the default", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await LegalHoldService.addHold("user-7", "legal@chronopay.io", "court order", "US");

      const [, params] = mockQuery.mock.calls[0] as [string, string[]];
      expect(params[3]).toBe("US");
    });

    it("propagates a rejected query without swallowing the error", async () => {
      mockQuery.mockRejectedValueOnce(new Error("connection reset by peer"));

      await expect(
        LegalHoldService.addHold("user-1", "ops", "test"),
      ).rejects.toThrow("connection reset by peer");
    });
  });

  // ─── isHeld ────────────────────────────────────────────────────────────────

  describe("isHeld", () => {
    it("returns true when rowCount is 1", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ "?column?": 1 }] });

      await expect(LegalHoldService.isHeld("user-42")).resolves.toBe(true);
    });

    it("returns false when rowCount is 0", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await expect(LegalHoldService.isHeld("user-42")).resolves.toBe(false);
    });

    it("returns false when rowCount is null (pg driver edge case)", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: null, rows: [] });

      await expect(LegalHoldService.isHeld("user-42")).resolves.toBe(false);
    });

    it("queries by subject_id with the correct parameter", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await LegalHoldService.isHeld("subject-abc");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
      expect(sql).toMatch(/WHERE subject_id = \$1/i);
      expect(params).toEqual(["subject-abc"]);
    });

    it("propagates a rejected query without swallowing the error", async () => {
      mockQuery.mockRejectedValueOnce(new Error("query timeout"));

      await expect(LegalHoldService.isHeld("user-1")).rejects.toThrow("query timeout");
    });
  });
});

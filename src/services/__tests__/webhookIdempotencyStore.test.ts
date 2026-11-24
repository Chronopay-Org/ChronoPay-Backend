import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockQuery = jest.fn() as any;

jest.unstable_mockModule("../../db/pool.js", () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

const { WebhookIdempotencyStore } = await import("../webhookIdempotencyStore.js");

describe("WebhookIdempotencyStore", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe("saveKey", () => {
    it("returns true and passes the default retention period to the query", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await expect(
        WebhookIdempotencyStore.saveKey("tenant-1", "event-1", { success: true }),
      ).resolves.toBe(true);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("NOW() + INTERVAL '1 day' * $4"),
        ["tenant-1", "event-1", JSON.stringify({ success: true }), 30],
      );
    });

    it("passes a custom retention period to the query", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

      await WebhookIdempotencyStore.saveKey("tenant-1", "event-2", {}, 7);

      expect(mockQuery.mock.calls[0][1]).toEqual(["tenant-1", "event-2", "{}", 7]);
    });

    it("returns false for a unique violation", async () => {
      mockQuery.mockRejectedValueOnce({ code: "23505" });

      await expect(WebhookIdempotencyStore.saveKey("tenant-1", "event-1", {})).resolves.toBe(false);
    });

    it("rethrows errors other than a unique violation", async () => {
      const error = { code: "40001" };
      mockQuery.mockRejectedValueOnce(error);

      await expect(WebhookIdempotencyStore.saveKey("tenant-1", "event-1", {})).rejects.toBe(error);
    });
  });

  describe("getExistingResponse", () => {
    it("returns the stored response and only considers unexpired keys", async () => {
      const responseBody = { success: true };
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ response_body: responseBody }],
      });

      await expect(
        WebhookIdempotencyStore.getExistingResponse("tenant-1", "event-1"),
      ).resolves.toBe(responseBody);

      expect(mockQuery.mock.calls[0][0]).toContain("expires_at > NOW()");
    });

    it.each([
      ["zero rows", { rowCount: 0, rows: [] }],
      ["an undefined row count", { rowCount: undefined, rows: [] }],
    ])("returns null when the query reports %s", async (_description, result) => {
      mockQuery.mockResolvedValueOnce(result);

      await expect(
        WebhookIdempotencyStore.getExistingResponse("tenant-1", "event-1"),
      ).resolves.toBeNull();
    });
  });

  describe("sweep", () => {
    it("returns the number of deleted keys", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 3, rows: [] });

      await expect(WebhookIdempotencyStore.sweep()).resolves.toBe(3);
    });

    it("returns zero when the query has no row count", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: undefined, rows: [] });

      await expect(WebhookIdempotencyStore.sweep()).resolves.toBe(0);
    });
  });

  describe("inspect", () => {
    it("returns a matching key record", async () => {
      const record = { tenant_id: "tenant-1", idempotency_key: "event-1" };
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [record] });

      await expect(WebhookIdempotencyStore.inspect("tenant-1", "event-1")).resolves.toBe(record);
    });

    it("returns null when no key record exists", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      await expect(
        WebhookIdempotencyStore.inspect("tenant-1", "missing-event"),
      ).resolves.toBeNull();
    });
  });
});

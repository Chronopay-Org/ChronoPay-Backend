import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";

const mockQuery = jest.fn() as any;
jest.unstable_mockModule("../../db/pool.js", () => ({
  query: mockQuery,
  default: { query: mockQuery },
}));

jest.unstable_mockModule("../auditLogger.js", () => ({
  defaultAuditLogger: { log: jest.fn(async () => undefined) },
}));

const {
  PartnerTokenSoftLimitService,
  deliverWarningWebhook,
  processPendingDeliveries,
  maybeEnqueueSoftLimitWarning,
  _setSoftLimitDeps,
  _resetSoftLimitDeps,
} = await import("../partnerTokenSoftLimitService.js");

describe("PartnerTokenSoftLimitService", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    _resetSoftLimitDeps();
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    _resetSoftLimitDeps();
  });

  describe("computeThreshold", () => {
    it("returns breached=true when usage meets soft limit", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(80, 100, 0.8);
      expect(result.breached).toBe(true);
      expect(result.thresholdPct).toBe(0.8);
    });

    it("returns breached=true at softLimit === 1.0 (threshold at 100%)", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(100, 100, 1.0);
      expect(result.breached).toBe(true);
      expect(result.thresholdPct).toBe(1);
    });

    it("returns breached=false below soft limit", () => {
      const result = PartnerTokenSoftLimitService.computeThreshold(50, 100, 0.8);
      expect(result.breached).toBe(false);
    });

    it("returns breached=false when hard cutoff is zero or negative", () => {
      expect(PartnerTokenSoftLimitService.computeThreshold(50, 0, 0.8).breached).toBe(false);
      expect(PartnerTokenSoftLimitService.computeThreshold(50, -1, 0.8).breached).toBe(false);
    });
  });

  describe("dedupeKey", () => {
    it("produces a stable key for the same partner and window", () => {
      const nowMs = 1_700_000_000_000;
      const key1 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85, nowMs);
      const key2 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85, nowMs);
      expect(key1).toBe(key2);
    });

    it("produces different keys for different partners", () => {
      const nowMs = 1_700_000_000_000;
      const key1 = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.85, nowMs);
      const key2 = PartnerTokenSoftLimitService.dedupeKey("partner-2", 0.85, nowMs);
      expect(key1).not.toBe(key2);
    });

    it("rounds threshold to integer percentage", () => {
      const key = PartnerTokenSoftLimitService.dedupeKey("partner-1", 0.856, 0);
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

    it("allows softLimit === 1.0", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });
      await PartnerTokenSoftLimitService.upsertConfig("p1", "https://hook.example.com", 1.0);
      expect(mockQuery.mock.calls[0][1][1]).toBe(1.0);
    });

    it("throws if webhookUrl is empty", async () => {
      await expect(PartnerTokenSoftLimitService.upsertConfig("p1", "")).rejects.toThrow(
        "webhookUrl is required",
      );
    });

    it("performs upsert query when valid", async () => {
      mockQuery.mockResolvedValue({ rowCount: 1 });
      await PartnerTokenSoftLimitService.upsertConfig("p1", "https://hook.example.com", 0.85);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0]).toContain("INSERT INTO partner_token_soft_limit_config");
    });
  });

  describe("getConfig", () => {
    it("returns null when no config exists", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      expect(await PartnerTokenSoftLimitService.getConfig("unknown")).toBeNull();
    });

    it("returns parsed config when found", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [{ partner_id: "p1", soft_limit: 0.8, webhook_url: "https://hook.example.com" }],
      });
      await expect(PartnerTokenSoftLimitService.getConfig("p1")).resolves.toEqual({
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
        attempt_count: 0,
        last_error: null,
        acked_at: null,
        dedupe_key: "p1:85:123",
        created_at: new Date(),
      };
      mockQuery.mockResolvedValue({ rows: [fakeRow] });

      const entry = await PartnerTokenSoftLimitService.enqueueWarning(
        "p1",
        85,
        0.85,
        "https://hook.example.com",
        0.8,
      );
      expect(entry).not.toBeNull();
      expect(entry!.partnerId).toBe("p1");
      expect(entry!.status).toBe("pending");
    });

    it("returns null on duplicate warning (unique_violation)", async () => {
      const pgError: any = new Error("duplicate key");
      pgError.code = "23505";
      mockQuery.mockRejectedValue(pgError);

      const entry = await PartnerTokenSoftLimitService.enqueueWarning(
        "p1",
        85,
        0.85,
        "https://hook.example.com",
        0.8,
      );
      expect(entry).toBeNull();
    });
  });

  describe("checkAndWarn", () => {
    it("returns null when partner has no config", async () => {
      mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
      expect(await PartnerTokenSoftLimitService.checkAndWarn("p1", 90, 100)).toBeNull();
    });

    it("returns null when usage is below soft limit", async () => {
      mockQuery.mockResolvedValue({
        rowCount: 1,
        rows: [{ partner_id: "p1", soft_limit: 0.8, webhook_url: "https://hook.example.com" }],
      });
      expect(await PartnerTokenSoftLimitService.checkAndWarn("p1", 50, 100)).toBeNull();
    });
  });

  describe("getRetryableDeliveries", () => {
    it("queries pending and failed entries under max attempts", async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await PartnerTokenSoftLimitService.getRetryableDeliveries(5);
      expect(mockQuery.mock.calls[0][0]).toContain("status IN ('pending', 'failed')");
      expect(mockQuery.mock.calls[0][1]).toEqual([5]);
    });
  });
});

describe("deliverWarningWebhook", () => {
  const entry = {
    id: "uuid-1",
    partnerId: "p1",
    tokenUsage: 85,
    softLimit: 0.8,
    thresholdPct: 0.85,
    webhookUrl: "https://hook.example.com/warn",
    status: "pending" as const,
    attemptCount: 0,
    lastError: null,
    ackedAt: null,
    dedupeKey: "p1:85:1",
    createdAt: new Date(),
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rowCount: 1 });
    _resetSoftLimitDeps();
  });

  afterEach(() => {
    _resetSoftLimitDeps();
  });

  it("acks ledger on 2xx response", async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 })) as any;
    _setSoftLimitDeps({ fetchFn, queryFn: mockQuery });

    await expect(deliverWarningWebhook(entry)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'acked'");
  });

  it("marks failed and stays retryable when partner webhook is down", async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 503 })) as any;
    _setSoftLimitDeps({ fetchFn, queryFn: mockQuery });

    await expect(deliverWarningWebhook(entry)).resolves.toBe(false);
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'failed'");
    expect(mockQuery.mock.calls[0][1][1]).toContain("503");
  });

  it("marks failed on network error", async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    _setSoftLimitDeps({ fetchFn, queryFn: mockQuery });

    await expect(deliverWarningWebhook(entry)).resolves.toBe(false);
    expect(mockQuery.mock.calls[0][1][1]).toContain("ECONNREFUSED");
  });
});

describe("processPendingDeliveries", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    _resetSoftLimitDeps();
  });

  afterEach(() => {
    _resetSoftLimitDeps();
  });

  it("delivers retryable entries and counts successes/failures", async () => {
    const rows = [
      {
        id: "a",
        partner_id: "p1",
        token_usage: 85,
        soft_limit: 0.8,
        threshold_pct: 0.85,
        webhook_url: "https://ok.example.com",
        status: "pending",
        attempt_count: 0,
        last_error: null,
        acked_at: null,
        dedupe_key: "p1:85:1",
        created_at: new Date(),
      },
      {
        id: "b",
        partner_id: "p2",
        token_usage: 90,
        soft_limit: 0.8,
        threshold_pct: 0.9,
        webhook_url: "https://down.example.com",
        status: "failed",
        attempt_count: 1,
        last_error: "HTTP 500",
        acked_at: null,
        dedupe_key: "p2:90:1",
        created_at: new Date(),
      },
    ];

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("partner_token_delivery_ledger")) {
        return { rows };
      }
      return { rowCount: 1 };
    });

    const fetchFn = jest.fn(async (_url: string) => {
      if (String(_url).includes("down")) {
        return { ok: false, status: 500 };
      }
      return { ok: true, status: 200 };
    }) as any;
    _setSoftLimitDeps({ fetchFn, queryFn: mockQuery });

    const result = await processPendingDeliveries();
    expect(result).toEqual({ delivered: 1, failed: 1 });
  });
});

describe("maybeEnqueueSoftLimitWarning", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    _resetSoftLimitDeps();
  });

  afterEach(() => {
    _resetSoftLimitDeps();
  });

  it("does not throw when config lookup fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    await expect(maybeEnqueueSoftLimitWarning("p1", 90, 100)).resolves.toBeUndefined();
  });
});

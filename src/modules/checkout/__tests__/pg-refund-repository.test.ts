import { jest } from "@jest/globals";
import { QueryResult } from "pg";
import { PgRefundRepository, defaultRefundRepository } from "../pg-refund-repository.js";
import { CreateRefundRequest, RefundEntry, RefundEntryStatus } from "../../../types/refund.js";

type MockQuery = jest.Mock<(text: string, params?: unknown[]) => Promise<QueryResult>>;

const NOW_MS = 1748000000000;
const NOW_S = Math.floor(NOW_MS / 1000);
const ISO_TIMESTAMP = new Date(NOW_MS).toISOString();

const sampleDbRow = {
  id: "refund-uuid-1",
  payment_id: "pay-123",
  amount_cents: 2500,
  currency: "USD",
  reason: "Customer requested return",
  status: "completed" as RefundEntryStatus,
  refunded_by: "agent-007",
  created_at: ISO_TIMESTAMP,
};

const expectedEntry: RefundEntry = {
  id: "refund-uuid-1",
  paymentId: "pay-123",
  amountCents: 2500,
  currency: "USD",
  reason: "Customer requested return",
  status: "completed",
  refundedBy: "agent-007",
  createdAt: NOW_S,
};

describe("PgRefundRepository", () => {
  let mockQuery: MockQuery;
  let repo: PgRefundRepository;

  beforeEach(() => {
    mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>();
    repo = new PgRefundRepository(
      mockQuery as unknown as (text: string, params?: unknown[]) => Promise<QueryResult>,
    );
  });

  describe("defaultRefundRepository export and constructor defaults", () => {
    it("exports defaultRefundRepository as an instance of PgRefundRepository", () => {
      expect(defaultRefundRepository).toBeInstanceOf(PgRefundRepository);
    });

    it("instantiates with default query function when no query parameter is provided", async () => {
      const defaultRepo = new PgRefundRepository();
      expect(defaultRepo).toBeInstanceOf(PgRefundRepository);

      // defaultQuery connects to the pool mock which returns { rows: [] }
      const result = await defaultRepo.findById("missing-id");
      expect(result).toBeNull();
    });

    it("allows defaultRefundRepository to execute queries via the default pool", async () => {
      const result = await defaultRefundRepository.findById("missing-id");
      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    it("inserts a refund entry with all fields provided and returns mapped record", async () => {
      const request: CreateRefundRequest = {
        paymentId: "pay-123",
        amountCents: 2500,
        currency: "EUR",
        reason: "Customer requested return",
        refundedBy: "agent-007",
      };

      const eurDbRow = { ...sampleDbRow, currency: "EUR" };
      mockQuery.mockResolvedValueOnce({ rows: [eurDbRow], rowCount: 1 } as QueryResult);

      const result = await repo.create(request);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO refund_entries"),
        ["pay-123", 2500, "EUR", "Customer requested return", "completed", "agent-007"],
      );
      expect(result).toEqual({ ...expectedEntry, currency: "EUR" });
    });

    it("defaults currency to 'USD' and passes null for reason and refundedBy when omitted", async () => {
      const request: CreateRefundRequest = {
        paymentId: "pay-123",
        amountCents: 1500,
      };

      const minimalRow = {
        ...sampleDbRow,
        amount_cents: 1500,
        currency: "USD",
        reason: null,
        refunded_by: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [minimalRow], rowCount: 1 } as QueryResult);

      const result = await repo.create(request);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO refund_entries"),
        ["pay-123", 1500, "USD", null, "completed", null],
      );
      expect(result).toEqual({
        id: "refund-uuid-1",
        paymentId: "pay-123",
        amountCents: 1500,
        currency: "USD",
        reason: undefined,
        status: "completed",
        refundedBy: undefined,
        createdAt: NOW_S,
      });
    });

    it("propagates database errors when query fails", async () => {
      const dbError = new Error("database connection lost");
      mockQuery.mockRejectedValueOnce(dbError);

      const request: CreateRefundRequest = {
        paymentId: "pay-123",
        amountCents: 1000,
      };

      await expect(repo.create(request)).rejects.toThrow("database connection lost");
    });

    it("propagates foreign key or constraint errors deterministically", async () => {
      const fkError = Object.assign(new Error("violates foreign key constraint"), {
        code: "23503",
      });
      mockQuery.mockRejectedValueOnce(fkError);

      const request: CreateRefundRequest = {
        paymentId: "non-existent-payment",
        amountCents: 1000,
      };

      await expect(repo.create(request)).rejects.toMatchObject({
        message: "violates foreign key constraint",
        code: "23503",
      });
    });
  });

  describe("findByPaymentId", () => {
    it("returns an array of mapped refund entries ordered by created_at", async () => {
      const row2 = {
        ...sampleDbRow,
        id: "refund-uuid-2",
        amount_cents: 1000,
        reason: "Second refund",
      };
      mockQuery.mockResolvedValueOnce({
        rows: [sampleDbRow, row2],
        rowCount: 2,
      } as QueryResult);

      const result = await repo.findByPaymentId("pay-123");

      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE payment_id = $1 ORDER BY created_at ASC"),
        ["pay-123"],
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(expectedEntry);
      expect(result[1]).toEqual({
        ...expectedEntry,
        id: "refund-uuid-2",
        amountCents: 1000,
        reason: "Second refund",
      });
    });

    it("returns an empty array when no refund entries match the paymentId", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as QueryResult);

      const result = await repo.findByPaymentId("pay-missing");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE payment_id = $1 ORDER BY created_at ASC"),
        ["pay-missing"],
      );
      expect(result).toEqual([]);
    });

    it("propagates database errors on query failure", async () => {
      mockQuery.mockRejectedValueOnce(new Error("query timeout"));

      await expect(repo.findByPaymentId("pay-123")).rejects.toThrow("query timeout");
    });
  });

  describe("sumRefundedCents", () => {
    it("returns the summed total as a number when database returns string total", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: "3500" }],
        rowCount: 1,
      } as QueryResult);

      const result = await repo.sumRefundedCents("pay-123");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refund_entries WHERE payment_id = $1",
        ),
        ["pay-123"],
      );
      expect(result).toBe(3500);
      expect(typeof result).toBe("number");
    });

    it("returns 0 when no refunds have occurred (COALESCE returns 0)", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: 0 }],
        rowCount: 1,
      } as QueryResult);

      const result = await repo.sumRefundedCents("pay-123");

      expect(result).toBe(0);
      expect(typeof result).toBe("number");
    });

    it("handles zero as string total from Postgres", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ total: "0" }],
        rowCount: 1,
      } as QueryResult);

      const result = await repo.sumRefundedCents("pay-123");

      expect(result).toBe(0);
    });

    it("propagates database errors on query failure", async () => {
      mockQuery.mockRejectedValueOnce(new Error("connection error"));

      await expect(repo.sumRefundedCents("pay-123")).rejects.toThrow("connection error");
    });
  });

  describe("findById", () => {
    it("returns mapped refund entry when record is found", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [sampleDbRow],
        rowCount: 1,
      } as QueryResult);

      const result = await repo.findById("refund-uuid-1");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM refund_entries WHERE id = $1"),
        ["refund-uuid-1"],
      );
      expect(result).toEqual(expectedEntry);
    });

    it("returns null when no record is found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as QueryResult);

      const result = await repo.findById("non-existent-id");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM refund_entries WHERE id = $1"),
        ["non-existent-id"],
      );
      expect(result).toBeNull();
    });

    it("propagates database errors on query failure", async () => {
      mockQuery.mockRejectedValueOnce(new Error("syntax error"));

      await expect(repo.findById("refund-uuid-1")).rejects.toThrow("syntax error");
    });
  });

  describe("mapRow mapping and state transitions", () => {
    it("maps pending and failed statuses correctly", async () => {
      const pendingRow = { ...sampleDbRow, status: "pending" as RefundEntryStatus };
      mockQuery.mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 } as QueryResult);
      const pendingResult = await repo.findById("refund-pending");
      expect(pendingResult?.status).toBe("pending");

      const failedRow = { ...sampleDbRow, status: "failed" as RefundEntryStatus };
      mockQuery.mockResolvedValueOnce({ rows: [failedRow], rowCount: 1 } as QueryResult);
      const failedResult = await repo.findById("refund-failed");
      expect(failedResult?.status).toBe("failed");
    });

    it("defaults currency to 'USD' if db row currency is null or undefined", async () => {
      const rowNullCurrency = { ...sampleDbRow, currency: null };
      mockQuery.mockResolvedValueOnce({ rows: [rowNullCurrency], rowCount: 1 } as QueryResult);

      const result = await repo.findById("refund-null-currency");
      expect(result?.currency).toBe("USD");
    });

    it("maps null or undefined reason and refunded_by to undefined", async () => {
      const rowNullFields = {
        ...sampleDbRow,
        reason: null,
        refunded_by: null,
      };
      mockQuery.mockResolvedValueOnce({ rows: [rowNullFields], rowCount: 1 } as QueryResult);

      const result = await repo.findById("refund-null-fields");
      expect(result?.reason).toBeUndefined();
      expect(result?.refundedBy).toBeUndefined();
    });

    it("correctly calculates createdAt epoch seconds from Date object or ISO string", async () => {
      const dateObj = new Date("2026-06-15T12:00:00.000Z");
      const expectedEpoch = Math.floor(dateObj.getTime() / 1000);

      const rowWithDate = { ...sampleDbRow, created_at: dateObj };
      mockQuery.mockResolvedValueOnce({ rows: [rowWithDate], rowCount: 1 } as QueryResult);

      const result = await repo.findById("refund-date-obj");
      expect(result?.createdAt).toBe(expectedEpoch);
    });
  });
});

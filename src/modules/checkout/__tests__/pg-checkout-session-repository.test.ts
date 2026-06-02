import { jest } from "@jest/globals";
import { QueryResult } from "pg";
import { PgCheckoutSessionRepository } from "../pg-checkout-session-repository.js";
import { CheckoutSession, CheckoutSessionStatus } from "../../../types/checkout.js";

type MockQuery = jest.Mock<(text: string, params?: unknown[]) => Promise<QueryResult>>;

const NOW_S = 1748000000;
const EXPIRES_S = NOW_S + 86400;

const dbRow = {
  id: "sess-uuid",
  payment: { amount: 100, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: "cust-1", email: "a@b.com" },
  status: "pending",
  metadata: null,
  success_url: "https://example.com/success",
  cancel_url: "https://example.com/cancel",
  payment_token: null,
  created_at: new Date(NOW_S * 1000).toISOString(),
  updated_at: new Date(NOW_S * 1000).toISOString(),
  expires_at: new Date(EXPIRES_S * 1000).toISOString(),
};

const expectedSession: CheckoutSession = {
  id: "sess-uuid",
  payment: { amount: 100, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: "cust-1", email: "a@b.com" },
  status: CheckoutSessionStatus.PENDING,
  metadata: undefined,
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
  paymentToken: undefined,
  createdAt: NOW_S,
  updatedAt: NOW_S,
  expiresAt: EXPIRES_S,
};

describe("PgCheckoutSessionRepository", () => {
  let mockQuery: MockQuery;
  let repo: PgCheckoutSessionRepository;

  beforeEach(() => {
    mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<QueryResult>>();
    repo = new PgCheckoutSessionRepository(mockQuery as any);
  });

  describe("create", () => {
    it("inserts a session and returns the mapped record", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repo.create(expectedSession);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO checkout_sessions"),
        expect.arrayContaining([
          "sess-uuid",
          JSON.stringify(expectedSession.payment),
          JSON.stringify(expectedSession.customer),
          "pending",
          null,
          "https://example.com/success",
          "https://example.com/cancel",
          null,
          NOW_S,
          NOW_S,
          EXPIRES_S,
        ]),
      );
      expect(result).toEqual(expectedSession);
    });

    it("serialises metadata when present", async () => {
      const withMeta = { ...expectedSession, metadata: { ref: "abc" } as any };
      mockQuery.mockResolvedValueOnce({
        rows: [{ ...dbRow, metadata: { ref: "abc" } }],
        rowCount: 1,
      } as any);

      await repo.create(withMeta);

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBe(JSON.stringify({ ref: "abc" }));
    });

    it("passes null for optional fields when absent", async () => {
      const minimal = {
        ...expectedSession,
        metadata: undefined,
        successUrl: undefined,
        cancelUrl: undefined,
        paymentToken: undefined,
      };
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      await repo.create(minimal);

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBeNull(); // metadata
      expect(params[5]).toBeNull(); // successUrl
      expect(params[6]).toBeNull(); // cancelUrl
      expect(params[7]).toBeNull(); // paymentToken
    });
  });

  describe("findById", () => {
    it("returns the mapped session when found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repo.findById("sess-uuid");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1"),
        ["sess-uuid"],
      );
      expect(result).toEqual(expectedSession);
    });

    it("returns null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repo.findById("missing");

      expect(result).toBeNull();
    });
  });

  describe("updateSession", () => {
    it("updates status and returns the mapped session", async () => {
      const updatedRow = { ...dbRow, status: "completed", payment_token: "tok_123" };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      const result = await repo.updateSession("sess-uuid", {
        status: CheckoutSessionStatus.COMPLETED,
        updatedAt: NOW_S,
        paymentToken: "tok_123",
      });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE checkout_sessions"),
        ["sess-uuid", "completed", NOW_S, "tok_123", null],
      );
      expect(result.status).toBe(CheckoutSessionStatus.COMPLETED);
      expect(result.paymentToken).toBe("tok_123");
    });

    it("passes metadata as JSON when provided", async () => {
      const updatedRow = { ...dbRow, status: "failed", metadata: { failureReason: "declined" } };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      await repo.updateSession("sess-uuid", {
        status: CheckoutSessionStatus.FAILED,
        updatedAt: NOW_S,
        metadata: { failureReason: "declined" },
      });

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params[4]).toBe(JSON.stringify({ failureReason: "declined" }));
    });

    it("passes null for paymentToken and metadata when omitted", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      await repo.updateSession("sess-uuid", {
        status: CheckoutSessionStatus.PENDING,
        updatedAt: NOW_S,
      });

      const params = mockQuery.mock.calls[0][1] as unknown[];
      expect(params[3]).toBeNull(); // paymentToken
      expect(params[4]).toBeNull(); // metadata
    });
  });

  describe("mapRow edge cases", () => {
    it("maps payment_token to paymentToken when present", async () => {
      const rowWithToken = { ...dbRow, payment_token: "tok_abc" };
      mockQuery.mockResolvedValueOnce({ rows: [rowWithToken], rowCount: 1 } as any);

      const result = await repo.findById("sess-uuid");

      expect(result?.paymentToken).toBe("tok_abc");
    });

    it("maps metadata JSONB to object when present", async () => {
      const rowWithMeta = { ...dbRow, metadata: { key: "val" } };
      mockQuery.mockResolvedValueOnce({ rows: [rowWithMeta], rowCount: 1 } as any);

      const result = await repo.findById("sess-uuid");

      expect(result?.metadata).toEqual({ key: "val" });
    });

    it("maps null success_url and cancel_url to undefined", async () => {
      const rowNoUrls = { ...dbRow, success_url: null, cancel_url: null };
      mockQuery.mockResolvedValueOnce({ rows: [rowNoUrls], rowCount: 1 } as any);

      const result = await repo.findById("sess-uuid");

      expect(result?.successUrl).toBeUndefined();
      expect(result?.cancelUrl).toBeUndefined();
    });
  });
});

import { PgCheckoutSessionRepository } from "./pg-checkout-session-repository.js";
import { CheckoutSession, CheckoutSessionStatus } from "../../types/checkout.js";

describe("PgCheckoutSessionRepository", () => {
  let repository: PgCheckoutSessionRepository;
  let mockDbQuery: jest.Mock;

  const mockSession: CheckoutSession = {
    id: "test-id-123",
    payment: {
      amount: 1000,
      currency: "USD",
      paymentMethod: "credit_card",
    },
    customer: {
      customerId: "cust-456",
      email: "test@example.com",
    },
    status: CheckoutSessionStatus.PENDING,
    metadata: { key: "value" },
    successUrl: "https://example.com/success",
    cancelUrl: "https://example.com/cancel",
    paymentToken: "token-789",
    createdAt: 1600000000,
    updatedAt: 1600000000,
    expiresAt: 1600003600,
  };

  const mockDbRow = {
    id: mockSession.id,
    payment: mockSession.payment,
    customer: mockSession.customer,
    status: mockSession.status,
    metadata: mockSession.metadata,
    success_url: mockSession.successUrl,
    cancel_url: mockSession.cancelUrl,
    payment_token: mockSession.paymentToken,
    created_at: new Date(mockSession.createdAt * 1000).toISOString(),
    updated_at: new Date(mockSession.updatedAt * 1000).toISOString(),
    expires_at: new Date(mockSession.expiresAt * 1000).toISOString(),
  };

  beforeEach(() => {
    mockDbQuery = jest.fn();
    repository = new PgCheckoutSessionRepository(mockDbQuery);
  });

  describe("create", () => {
    it("creates a checkout session and maps the row correctly", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [mockDbRow] });

      const result = await repository.create(mockSession);

      expect(mockDbQuery).toHaveBeenCalledTimes(1);
      const args = mockDbQuery.mock.calls[0];
      expect(args[0]).toContain("INSERT INTO checkout_sessions");
      expect(args[1]).toEqual([
        mockSession.id,
        JSON.stringify(mockSession.payment),
        JSON.stringify(mockSession.customer),
        mockSession.status,
        JSON.stringify(mockSession.metadata),
        mockSession.successUrl,
        mockSession.cancelUrl,
        mockSession.paymentToken,
        mockSession.createdAt,
        mockSession.updatedAt,
        mockSession.expiresAt,
      ]);

      expect(result).toEqual(mockSession);
    });

    it("handles optional fields properly", async () => {
      const minimalSession: CheckoutSession = {
        ...mockSession,
        metadata: undefined,
        successUrl: undefined,
        cancelUrl: undefined,
        paymentToken: undefined,
      };

      const minimalDbRow = {
        ...mockDbRow,
        metadata: null,
        success_url: null,
        cancel_url: null,
        payment_token: null,
      };

      mockDbQuery.mockResolvedValueOnce({ rows: [minimalDbRow] });

      const result = await repository.create(minimalSession);

      expect(mockDbQuery).toHaveBeenCalledTimes(1);
      expect(mockDbQuery.mock.calls[0][1]).toEqual([
        minimalSession.id,
        JSON.stringify(minimalSession.payment),
        JSON.stringify(minimalSession.customer),
        minimalSession.status,
        null,
        null,
        null,
        null,
        minimalSession.createdAt,
        minimalSession.updatedAt,
        minimalSession.expiresAt,
      ]);

      expect(result).toEqual({
        ...minimalSession,
        metadata: undefined,
        successUrl: undefined,
        cancelUrl: undefined,
        paymentToken: undefined,
      });
    });
  });

  describe("findById", () => {
    it("returns null when not found", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findById("some-id");

      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM checkout_sessions WHERE id = $1"),
        ["some-id"]
      );
      expect(result).toBeNull();
    });

    it("returns mapped session when found", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [mockDbRow] });

      const result = await repository.findById("test-id-123");

      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM checkout_sessions WHERE id = $1"),
        ["test-id-123"]
      );
      expect(result).toEqual(mockSession);
    });
  });

  describe("updateSession", () => {
    it("updates status, updatedAt, paymentToken, and metadata", async () => {
      const updatedRow = {
        ...mockDbRow,
        status: CheckoutSessionStatus.COMPLETED,
        updated_at: new Date(1600001000 * 1000).toISOString(),
        payment_token: "new-token",
        metadata: { key: "new-value" },
      };

      mockDbQuery.mockResolvedValueOnce({ rows: [updatedRow] });

      const fields = {
        status: CheckoutSessionStatus.COMPLETED,
        updatedAt: 1600001000,
        paymentToken: "new-token",
        metadata: { key: "new-value" },
      };

      const result = await repository.updateSession("test-id-123", fields);

      expect(mockDbQuery).toHaveBeenCalledTimes(1);
      const args = mockDbQuery.mock.calls[0];
      expect(args[0]).toContain("UPDATE checkout_sessions");
      expect(args[1]).toEqual([
        "test-id-123",
        fields.status,
        fields.updatedAt,
        fields.paymentToken,
        JSON.stringify(fields.metadata),
      ]);

      expect(result).toEqual({
        ...mockSession,
        status: CheckoutSessionStatus.COMPLETED,
        updatedAt: 1600001000,
        paymentToken: "new-token",
        metadata: { key: "new-value" },
      });
    });

    it("handles partial updates without optional fields", async () => {
      const updatedRow = {
        ...mockDbRow,
        status: CheckoutSessionStatus.FAILED,
        updated_at: new Date(1600002000 * 1000).toISOString(),
      };

      mockDbQuery.mockResolvedValueOnce({ rows: [updatedRow] });

      const fields = {
        status: CheckoutSessionStatus.FAILED,
        updatedAt: 1600002000,
      };

      const result = await repository.updateSession("test-id-123", fields);

      expect(mockDbQuery).toHaveBeenCalledTimes(1);
      const args = mockDbQuery.mock.calls[0];
      expect(args[0]).toContain("UPDATE checkout_sessions");
      expect(args[1]).toEqual([
        "test-id-123",
        fields.status,
        fields.updatedAt,
        null,
        null,
      ]);

      expect(result).toEqual({
        ...mockSession,
        status: CheckoutSessionStatus.FAILED,
        updatedAt: 1600002000,
      });
    });
  });
});

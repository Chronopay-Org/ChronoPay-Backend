import { jest } from "@jest/globals";
import { CheckoutSessionService, setCheckoutRepository } from "../../../services/checkout.js";
import { PgCheckoutSessionRepository } from "../pg-checkout-session-repository.js";
import {
  CheckoutSession,
  CheckoutSessionStatus,
  CheckoutErrorCode,
  CreateCheckoutSessionRequest,
} from "../../../types/checkout.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const NOW_S = 1748000000;
const EXPIRES_S = NOW_S + 86400;

function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: "sess-uuid",
    payment: { amount: 100, currency: "USD", paymentMethod: "credit_card" },
    customer: { customerId: "cust-1", email: "a@b.com" },
    status: CheckoutSessionStatus.PENDING,
    createdAt: NOW_S,
    updatedAt: NOW_S,
    expiresAt: EXPIRES_S,
    ...overrides,
  };
}

const baseRequest: CreateCheckoutSessionRequest = {
  payment: { amount: 100, currency: "USD", paymentMethod: "credit_card" },
  customer: { customerId: "cust-1", email: "a@b.com" },
};

// ── mock repo ─────────────────────────────────────────────────────────────────

function makeMockRepo(overrides: Partial<PgCheckoutSessionRepository> = {}) {
  return {
    create: jest.fn<PgCheckoutSessionRepository["create"]>(),
    findById: jest.fn<PgCheckoutSessionRepository["findById"]>(),
    updateSession: jest.fn<PgCheckoutSessionRepository["updateSession"]>(),
    ...overrides,
  } as unknown as PgCheckoutSessionRepository;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("CheckoutSessionService", () => {
  let repo: ReturnType<typeof makeMockRepo>;

  beforeEach(() => {
    repo = makeMockRepo();
    setCheckoutRepository(repo);
    jest.spyOn(Date, "now").mockReturnValue(NOW_S * 1000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── createSession ──────────────────────────────────────────────────────────

  describe("createSession", () => {
    it("creates and returns a new session", async () => {
      const session = makeSession();
      (repo.create as jest.Mock).mockResolvedValueOnce(session);

      const result = await CheckoutSessionService.createSession(baseRequest);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payment: baseRequest.payment,
          customer: baseRequest.customer,
          status: CheckoutSessionStatus.PENDING,
          createdAt: NOW_S,
          expiresAt: NOW_S + 86400,
        }),
      );
      expect(result).toEqual(session);
    });

    it("throws UNAUTHORIZED when REQUIRE_AUTH=true and no token", async () => {
      process.env.REQUIRE_AUTH = "true";
      try {
        await expect(
          CheckoutSessionService.createSession(baseRequest),
        ).rejects.toMatchObject({ code: CheckoutErrorCode.UNAUTHORIZED, status: 401 });
      } finally {
        delete process.env.REQUIRE_AUTH;
      }
    });

    it("passes through when REQUIRE_AUTH=true and token provided", async () => {
      process.env.REQUIRE_AUTH = "true";
      const session = makeSession();
      (repo.create as jest.Mock).mockResolvedValueOnce(session);
      try {
        const result = await CheckoutSessionService.createSession(baseRequest, "tok");
        expect(result).toEqual(session);
      } finally {
        delete process.env.REQUIRE_AUTH;
      }
    });
  });

  // ── getSession ─────────────────────────────────────────────────────────────

  describe("getSession", () => {
    it("returns a valid pending session", async () => {
      const session = makeSession();
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);

      const result = await CheckoutSessionService.getSession("sess-uuid");

      expect(result).toEqual(session);
    });

    it("throws SESSION_NOT_FOUND for unknown id", async () => {
      (repo.findById as jest.Mock).mockResolvedValueOnce(null);

      await expect(CheckoutSessionService.getSession("missing")).rejects.toMatchObject({
        code: CheckoutErrorCode.SESSION_NOT_FOUND,
        status: 404,
      });
    });

    it("throws SESSION_EXPIRED and persists expired status when past expiresAt", async () => {
      const expired = makeSession({ expiresAt: NOW_S - 1 });
      (repo.findById as jest.Mock).mockResolvedValueOnce(expired);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce({
        ...expired,
        status: CheckoutSessionStatus.EXPIRED,
      });

      await expect(CheckoutSessionService.getSession("sess-uuid")).rejects.toMatchObject({
        code: CheckoutErrorCode.SESSION_EXPIRED,
        status: 410,
      });

      expect(repo.updateSession).toHaveBeenCalledWith(
        "sess-uuid",
        expect.objectContaining({ status: CheckoutSessionStatus.EXPIRED }),
      );
    });

    it("throws SESSION_EXPIRED immediately for already-expired status", async () => {
      const expired = makeSession({ status: CheckoutSessionStatus.EXPIRED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(expired);

      await expect(CheckoutSessionService.getSession("sess-uuid")).rejects.toMatchObject({
        code: CheckoutErrorCode.SESSION_EXPIRED,
        status: 410,
      });
      // Should not call updateSession again
      expect(repo.updateSession).not.toHaveBeenCalled();
    });
  });

  // ── completeSession ────────────────────────────────────────────────────────

  describe("completeSession", () => {
    it("completes a pending session", async () => {
      const session = makeSession();
      const completed = makeSession({ status: CheckoutSessionStatus.COMPLETED, paymentToken: "tok" });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(completed);

      const result = await CheckoutSessionService.completeSession("sess-uuid", "tok");

      expect(repo.updateSession).toHaveBeenCalledWith(
        "sess-uuid",
        expect.objectContaining({ status: CheckoutSessionStatus.COMPLETED, paymentToken: "tok" }),
      );
      expect(result.status).toBe(CheckoutSessionStatus.COMPLETED);
    });

    it("throws INVALID_SESSION_STATE when already completed", async () => {
      const session = makeSession({ status: CheckoutSessionStatus.COMPLETED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);

      await expect(
        CheckoutSessionService.completeSession("sess-uuid"),
      ).rejects.toMatchObject({ code: CheckoutErrorCode.INVALID_SESSION_STATE, status: 409 });
    });

    it("throws SESSION_EXPIRED when trying to complete an expired session", async () => {
      const expired = makeSession({ expiresAt: NOW_S - 1 });
      (repo.findById as jest.Mock).mockResolvedValueOnce(expired);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce({
        ...expired,
        status: CheckoutSessionStatus.EXPIRED,
      });

      await expect(
        CheckoutSessionService.completeSession("sess-uuid"),
      ).rejects.toMatchObject({ code: CheckoutErrorCode.SESSION_EXPIRED, status: 410 });
    });
  });

  // ── failSession ────────────────────────────────────────────────────────────

  describe("failSession", () => {
    it("fails a pending session and stores failure reason in metadata", async () => {
      const session = makeSession();
      const failed = makeSession({
        status: CheckoutSessionStatus.FAILED,
        metadata: { failureReason: "declined" },
      });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(failed);

      const result = await CheckoutSessionService.failSession("sess-uuid", "declined");

      expect(repo.updateSession).toHaveBeenCalledWith(
        "sess-uuid",
        expect.objectContaining({
          status: CheckoutSessionStatus.FAILED,
          metadata: { failureReason: "declined" },
        }),
      );
      expect(result.status).toBe(CheckoutSessionStatus.FAILED);
    });

    it("uses 'Unknown' as default failure reason", async () => {
      const session = makeSession();
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(
        makeSession({ status: CheckoutSessionStatus.FAILED }),
      );

      await CheckoutSessionService.failSession("sess-uuid");

      expect(repo.updateSession).toHaveBeenCalledWith(
        "sess-uuid",
        expect.objectContaining({ metadata: { failureReason: "Unknown" } }),
      );
    });

    it("throws INVALID_SESSION_STATE when not pending", async () => {
      const session = makeSession({ status: CheckoutSessionStatus.CANCELLED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);

      await expect(
        CheckoutSessionService.failSession("sess-uuid"),
      ).rejects.toMatchObject({ code: CheckoutErrorCode.INVALID_SESSION_STATE, status: 409 });
    });
  });

  // ── cancelSession ──────────────────────────────────────────────────────────

  describe("cancelSession", () => {
    it("cancels a pending session", async () => {
      const session = makeSession();
      const cancelled = makeSession({ status: CheckoutSessionStatus.CANCELLED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(cancelled);

      const result = await CheckoutSessionService.cancelSession("sess-uuid");

      expect(result.status).toBe(CheckoutSessionStatus.CANCELLED);
    });

    it("throws INVALID_SESSION_STATE when already completed", async () => {
      const session = makeSession({ status: CheckoutSessionStatus.COMPLETED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);

      await expect(
        CheckoutSessionService.cancelSession("sess-uuid"),
      ).rejects.toMatchObject({ code: CheckoutErrorCode.INVALID_SESSION_STATE, status: 409 });
    });
  });

  // ── paySession ─────────────────────────────────────────────────────────────

  describe("paySession", () => {
    it("completes the session when payment succeeds", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0.5); // > 0.1 → success
      const session = makeSession();
      const completed = makeSession({ status: CheckoutSessionStatus.COMPLETED, paymentToken: "mock_token_123" });
      // getSession → findById, then completeSession → findById again
      (repo.findById as jest.Mock)
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(completed);

      const result = await CheckoutSessionService.paySession("sess-uuid");

      expect(result.status).toBe(CheckoutSessionStatus.COMPLETED);
    });

    it("fails the session when payment is declined", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0.05); // < 0.1 → failure
      const session = makeSession();
      const failed = makeSession({ status: CheckoutSessionStatus.FAILED });
      (repo.findById as jest.Mock)
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(session);
      (repo.updateSession as jest.Mock).mockResolvedValueOnce(failed);

      const result = await CheckoutSessionService.paySession("sess-uuid");

      expect(result.status).toBe(CheckoutSessionStatus.FAILED);
    });

    it("throws INVALID_SESSION_STATE when not pending", async () => {
      const session = makeSession({ status: CheckoutSessionStatus.COMPLETED });
      (repo.findById as jest.Mock).mockResolvedValueOnce(session);

      await expect(
        CheckoutSessionService.paySession("sess-uuid"),
      ).rejects.toMatchObject({ code: CheckoutErrorCode.INVALID_SESSION_STATE, status: 409 });
    });
  });
});

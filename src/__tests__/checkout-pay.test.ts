// @ts-nocheck
import { jest } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";
import {
  setCheckoutPaymentProvider,
  setCheckoutRepository,
  CheckoutSessionService,
} from "../services/checkout.js";
import { setFeatureFlagsFromEnv } from "../flags/index.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";
import { MockPaymentProvider } from "../services/paymentProvider.js";
import { CheckoutSession, CheckoutSessionStatus } from "../types/checkout.js";
import { randomUUID } from "crypto";

const app = createApp({ enableContentNegotiation: false });

beforeEach(() => {
  process.env.FF_CHECKOUT = 'true';
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

afterAll(() => {
  delete process.env.FF_CHECKOUT;
  setCheckoutPaymentProvider(undefined);
  setFeatureFlagsFromEnv(process.env);
  CheckoutSessionService.clearAllSessions();
});

// ── helpers ───────────────────────────────────────────────────────────────────

const NOW_S = Math.floor(Date.now() / 1000);

function makeSession(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: randomUUID(),
    payment: { amount: 100, currency: "USD", paymentMethod: "credit_card" },
    customer: { customerId: "cust-1", email: "test@example.com" },
    status: CheckoutSessionStatus.PENDING,
    createdAt: NOW_S,
    updatedAt: NOW_S,
    expiresAt: NOW_S + 86400,
    ...overrides,
  };
}

function makeMockRepo(overrides: Partial<PgCheckoutSessionRepository> = {}) {
  return {
    create: jest.fn<PgCheckoutSessionRepository["create"]>(),
    findById: jest.fn<PgCheckoutSessionRepository["findById"]>(),
    updateSession: jest.fn<PgCheckoutSessionRepository["updateSession"]>(),
    ...overrides,
  } as unknown as PgCheckoutSessionRepository;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/v1/checkout/sessions/:sessionId/pay", () => {
  let repo: ReturnType<typeof makeMockRepo>;

  beforeEach(() => {
    repo = makeMockRepo();
    setCheckoutRepository(repo);
    setCheckoutPaymentProvider({
      charge: async () => ({ status: "succeeded", providerRef: "provider_ref_123" }),
    });
  });

  it("should process payment for a pending session (completed path)", async () => {
    const session = makeSession();
    const completed = makeSession({ id: session.id, status: CheckoutSessionStatus.COMPLETED, paymentToken: "provider_ref_123" });

    (repo.findById as jest.Mock)
      .mockResolvedValueOnce(session)  // paySession → getSession
      .mockResolvedValueOnce(session); // completeSession → getSession
    (repo.updateSession as jest.Mock).mockResolvedValueOnce(completed);

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${session.id}/pay`)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe(CheckoutSessionStatus.COMPLETED);
    expect(repo.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({
      paymentToken: "provider_ref_123",
    }));
  });

  it("should process payment for a pending session (failed path)", async () => {
    setCheckoutPaymentProvider({
      charge: async () => ({
        status: "declined",
        providerRef: "declined_ref_123",
        reason: "Insufficient funds",
      }),
    });
    const session = makeSession();
    const failed = makeSession({
      id: session.id,
      status: CheckoutSessionStatus.FAILED,
      metadata: { failureReason: "Insufficient funds" },
    });

    (repo.findById as jest.Mock)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session);
    (repo.updateSession as jest.Mock).mockResolvedValueOnce(failed);

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${session.id}/pay`)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe(CheckoutSessionStatus.FAILED);
    expect(repo.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({
      metadata: { failureReason: "Insufficient funds" },
    }));
  });

  it("returns 503 in production without a provider and leaves the session pending", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    setCheckoutPaymentProvider(undefined);
    expect(() => setCheckoutPaymentProvider(new MockPaymentProvider())).toThrow(
      "Mock payment provider cannot be used in production",
    );
    const session = makeSession();
    (repo.findById as jest.Mock).mockResolvedValueOnce(session);

    try {
      const res = await request(app)
        .post(`/api/v1/checkout/sessions/${session.id}/pay`)
        .set("Content-Type", "application/json");

      expect(res.status).toBe(503);
      expect(res.body.code).toBe("PAYMENT_PROVIDER_UNAVAILABLE");
      expect(JSON.stringify(res.body)).not.toContain("mock_token_123");
      expect(repo.updateSession).not.toHaveBeenCalled();
      expect(session.status).toBe(CheckoutSessionStatus.PENDING);
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("should return 400 for invalid session ID format", async () => {
    const res = await request(app)
      .post("/api/v1/checkout/sessions/invalid-id/pay")
      .set("Content-Type", "application/json");
    expect(res.status).toBe(400);
  });

  it("should return 404 for non-existent session", async () => {
    (repo.findById as jest.Mock).mockResolvedValueOnce(null);

    const res = await request(app)
      .post("/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/pay")
      .set("Content-Type", "application/json");
    expect(res.status).toBe(404);
  });

  it("should return 409 for already completed session", async () => {
    const session = makeSession({ status: CheckoutSessionStatus.COMPLETED });
    (repo.findById as jest.Mock).mockResolvedValueOnce(session);

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${session.id}/pay`)
      .set("Content-Type", "application/json");
    expect(res.status).toBe(409);
  });

  it("should return 410 for expired session", async () => {
    const expired = makeSession({ expiresAt: NOW_S - 1 });
    (repo.findById as jest.Mock).mockResolvedValueOnce(expired);
    (repo.updateSession as jest.Mock).mockResolvedValueOnce({
      ...expired,
      status: CheckoutSessionStatus.EXPIRED,
    });

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${expired.id}/pay`)
      .set("Content-Type", "application/json");
    expect(res.status).toBe(410);
  });
});

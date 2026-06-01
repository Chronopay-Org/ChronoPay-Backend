import { jest } from "@jest/globals";
import request from "supertest";
import { createApp } from "../app.js";
import { setCheckoutRepository } from "../services/checkout.js";
import { PgCheckoutSessionRepository } from "../modules/checkout/pg-checkout-session-repository.js";
import { CheckoutSession, CheckoutSessionStatus } from "../types/checkout.js";
import { randomUUID } from "crypto";

const app = createApp({ enableDocs: false });

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
  });

  it("should process payment for a pending session (completed path)", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.5); // success
    const session = makeSession();
    const completed = makeSession({ id: session.id, status: CheckoutSessionStatus.COMPLETED, paymentToken: "mock_token_123" });

    (repo.findById as jest.Mock)
      .mockResolvedValueOnce(session)  // paySession → getSession
      .mockResolvedValueOnce(session); // completeSession → getSession
    (repo.updateSession as jest.Mock).mockResolvedValueOnce(completed);

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${session.id}/pay`)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe(CheckoutSessionStatus.COMPLETED);
    jest.restoreAllMocks();
  });

  it("should process payment for a pending session (failed path)", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0.05); // failure
    const session = makeSession();
    const failed = makeSession({ id: session.id, status: CheckoutSessionStatus.FAILED });

    (repo.findById as jest.Mock)
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(session);
    (repo.updateSession as jest.Mock).mockResolvedValueOnce(failed);

    const res = await request(app)
      .post(`/api/v1/checkout/sessions/${session.id}/pay`)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe(CheckoutSessionStatus.FAILED);
    jest.restoreAllMocks();
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

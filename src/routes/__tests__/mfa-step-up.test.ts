/**
 * Step-up MFA coverage for the high-risk money and admin routes mounted with
 * `requireFreshMfa`: admin refunds, webhook secret rotation, payout replay
 * approval, escrow pause, and customer booking refunds (gated by
 * MFA_REQUIRED_FOR_REFUNDS).
 *
 * Challenge tokens are issued through `mfaService.issueChallenge` with an
 * injected `challengeSecret` and clock (`nowMs`), so fixtures exercise the
 * real signing/verification path rather than snapshotting opaque JWTs.
 */
import request from "supertest";
import express from "express";
import adminRouter, { pendingReplays } from "../admin.js";
import { createBookingIntentsRouter } from "../booking-intents.js";
import { configService } from "../../config/config.service.js";
import { mfaService } from "../../services/mfaService.js";
import { _settlements } from "../../services/settlementReconciler.js";
import { escrowMigrationState } from "../../services/escrowMigrationState.js";
import { setFeatureFlagsFromEnv } from "../../flags/service.js";
import { featureFlagContextMiddleware } from "../../middleware/featureFlags.js";
import {
  InMemoryBookingIntentRepository,
  type BookingIntentRecord,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { setRefundRepository, setSessionRepositoryForRefund } from "../../services/refund.js";
import { setCheckoutRepository } from "../../services/checkout.js";
import { CheckoutSessionStatus } from "../../types/checkout.js";
import type { PgRefundRepository } from "../../modules/checkout/pg-refund-repository.js";
import type { PgCheckoutSessionRepository } from "../../modules/checkout/pg-checkout-session-repository.js";

const CHALLENGE_SECRET = "step-up-challenge-secret-12345";
const ADMIN_TOKEN = "step-up-admin-token";
const FRESHNESS_MS = 15 * 60 * 1000;
const STALE_AGE_MS = FRESHNESS_MS + 60 * 1000;

/** `configService.refresh()` reloads secrets asynchronously; drain the queue. */
async function flushConfig(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Issues a challenge token, injecting the signing secret and the clock
 * (`nowMs` back-dates `iat`/`mfa_at`; `exp` stays on the real clock so an
 * old-but-unexpired token exercises the freshness window, not JWT expiry).
 */
async function challengeFor(subject: string, options: { ageMs?: number } = {}): Promise<string> {
  const { mfaToken } = await mfaService.issueChallenge(subject, {
    challengeSecret: CHALLENGE_SECRET,
    nowMs: Date.now() - (options.ageMs ?? 0),
    challengeTtlSec: 3600,
  });
  return mfaToken;
}

const adminApp = express();
adminApp.use(express.json());
adminApp.use("/api/v1/admin", adminRouter);

beforeAll(() => {
  process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.MFA_CHALLENGE_SECRET = CHALLENGE_SECRET;
  process.env.MFA_FRESHNESS_MS = String(FRESHNESS_MS);
  delete process.env.MFA_REQUIRED_FOR_REFUNDS;
  configService.refresh();
});

beforeEach(async () => {
  await flushConfig();
});

afterAll(() => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
  delete process.env.MFA_CHALLENGE_SECRET;
  delete process.env.MFA_FRESHNESS_MS;
  delete process.env.MFA_REQUIRED_FOR_REFUNDS;
  delete process.env.FF_CREATE_BOOKING_INTENT;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;
  configService.refresh();
  setFeatureFlagsFromEnv(process.env);
  escrowMigrationState.setPaused(false);
});

// ─── In-memory fakes for the admin refund path (same shapes as
// admin.refunds.test.ts) so the "fresh challenge" case reaches the handler. ──

class InMemoryRefundRepo {
  private store: Map<string, any> = new Map();

  async create(request: any): Promise<any> {
    const id = `refund-${this.store.size + 1}`;
    const entry = {
      id,
      paymentId: request.paymentId,
      amountCents: request.amountCents,
      currency: request.currency ?? "USD",
      reason: request.reason ?? null,
      status: "completed" as const,
      refundedBy: request.refundedBy ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.store.set(id, entry);
    return { ...entry, reason: entry.reason ?? undefined, refundedBy: entry.refundedBy ?? undefined };
  }

  async findByPaymentId(paymentId: string): Promise<any[]> {
    return Array.from(this.store.values())
      .filter((e) => e.paymentId === paymentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async sumRefundedCents(paymentId: string): Promise<number> {
    return Array.from(this.store.values())
      .filter((e) => e.paymentId === paymentId)
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }
}

class InMemorySessionRepo {
  private store: Map<string, any> = new Map();

  async create(session: any): Promise<any> {
    this.store.set(session.id, { ...session });
    return session;
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }

  async updateSession(id: string, fields: any): Promise<void> {
    const session = this.store.get(id);
    if (!session) throw new Error("Not found");
    Object.assign(session, fields);
  }
}

// ─── POST /api/v1/admin/refunds ─────────────────────────────────────────────

describe("POST /api/v1/admin/refunds — MFA step-up", () => {
  let sessionRepo: InMemorySessionRepo;

  beforeEach(() => {
    sessionRepo = new InMemorySessionRepo();
    setRefundRepository(new InMemoryRefundRepo() as unknown as PgRefundRepository);
    setSessionRepositoryForRefund(sessionRepo as unknown as PgCheckoutSessionRepository);
    setCheckoutRepository(sessionRepo as unknown as PgCheckoutSessionRepository);
  });

  async function seedCompletedSession(id: string, amountCents = 1000): Promise<void> {
    await sessionRepo.create({
      id,
      payment: { amount: amountCents, currency: "USD", paymentMethod: "credit_card" },
      customer: { customerId: "c1", email: "a@b.com" },
      status: CheckoutSessionStatus.COMPLETED,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 999999,
    });
  }

  it("returns 401 Missing MFA challenge without the header", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/refunds")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-refunder")
      .send({ paymentId: "s1", amountCents: 100 });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
  });

  it("returns 403 with another user's challenge", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/refunds")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-refunder")
      .set("x-chronopay-mfa", await challengeFor("someone-else"))
      .send({ paymentId: "s1", amountCents: 100 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
  });

  it("returns 401 when the challenge is older than mfaFreshnessMs", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/refunds")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-refunder")
      .set("x-chronopay-mfa", await challengeFor("admin-refunder", { ageMs: STALE_AGE_MS }))
      .send({ paymentId: "s1", amountCents: 100 });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: "MFA challenge has expired; please verify again",
    });
  });

  it("creates the refund with a fresh challenge for the same subject", async () => {
    await seedCompletedSession("session-1");

    const res = await request(adminApp)
      .post("/api/v1/admin/refunds")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-refunder")
      .set("x-chronopay-mfa", await challengeFor("admin-refunder"))
      .send({ paymentId: "session-1", amountCents: 300, reason: "partial refund" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.refund.paymentId).toBe("session-1");
    expect(res.body.refund.amountCents).toBe(300);
  });

  it("falls back to the stable admin subject when no identity header is sent", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/refunds")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-mfa", await challengeFor("admin"))
      .send({});

    // Reaches the handler (which rejects the empty body), proving the
    // fallback subject passed the step-up gate.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("paymentId");
  });
});

// ─── POST /api/v1/admin/webhooks/rotate ─────────────────────────────────────

describe("POST /api/v1/admin/webhooks/rotate — MFA step-up", () => {
  afterEach(() => {
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET;
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS;
    delete process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT;
  });

  it("returns 401 Missing MFA challenge without the header", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/webhooks/rotate")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-ops");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
  });

  it("returns 403 with another user's challenge", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/webhooks/rotate")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-ops")
      .set("x-chronopay-mfa", await challengeFor("someone-else"));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
  });

  it("returns 401 when the challenge is older than mfaFreshnessMs", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/webhooks/rotate")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-ops")
      .set("x-chronopay-mfa", await challengeFor("admin-ops", { ageMs: STALE_AGE_MS }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: "MFA challenge has expired; please verify again",
    });
  });

  it("rotates the secret with a fresh challenge for the same subject", async () => {
    process.env.SETTLEMENTS_WEBHOOK_SECRET = "old-current";
    process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT = "new-current";

    const res = await request(adminApp)
      .post("/api/v1/admin/webhooks/rotate")
      .set("x-chronopay-admin-token", ADMIN_TOKEN)
      .set("x-chronopay-user-id", "admin-ops")
      .set("x-chronopay-mfa", await challengeFor("admin-ops"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(process.env.SETTLEMENTS_WEBHOOK_SECRET).toBe("new-current");
    expect(process.env.SETTLEMENTS_WEBHOOK_SECRET_PREVIOUS).toBe("old-current");
    expect(process.env.SETTLEMENTS_WEBHOOK_SECRET_NEXT).toBeUndefined();
  });
});

// ─── POST /api/v1/admin/payouts/:transactionId/replay/approve ───────────────

describe("POST /api/v1/admin/payouts/:transactionId/replay/approve — MFA step-up", () => {
  const transactionId = "tx-mfa-1";

  beforeEach(() => {
    _settlements.clear();
    pendingReplays.clear();
    _settlements.set(transactionId, {
      transactionId,
      eventType: "PAYOUT",
      amount: 100,
      timestamp: Date.now(),
      status: "failed",
      confirmations: 0,
      attempts: 5,
    });
    pendingReplays.set(transactionId, {
      transactionId,
      initiatorId: "admin-1",
      reason: "Network issue",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  });

  afterEach(() => {
    _settlements.clear();
    pendingReplays.clear();
  });

  it("returns 401 Missing MFA challenge without the header", async () => {
    const res = await request(adminApp)
      .post(`/api/v1/admin/payouts/${transactionId}/replay/approve`)
      .set("x-chronopay-user-id", "admin-2")
      .set("x-chronopay-role", "admin");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
  });

  it("returns 403 with another user's challenge", async () => {
    const res = await request(adminApp)
      .post(`/api/v1/admin/payouts/${transactionId}/replay/approve`)
      .set("x-chronopay-user-id", "admin-2")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("admin-1"));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
  });

  it("returns 401 when the challenge is older than mfaFreshnessMs", async () => {
    const res = await request(adminApp)
      .post(`/api/v1/admin/payouts/${transactionId}/replay/approve`)
      .set("x-chronopay-user-id", "admin-2")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("admin-2", { ageMs: STALE_AGE_MS }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: "MFA challenge has expired; please verify again",
    });
  });

  it("approves the replay with a fresh challenge for the same subject", async () => {
    const res = await request(adminApp)
      .post(`/api/v1/admin/payouts/${transactionId}/replay/approve`)
      .set("x-chronopay-user-id", "admin-2")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("admin-2"));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settlement.status).toBe("pending_finality");
    expect(pendingReplays.has(transactionId)).toBe(false);
  });
});

// ─── POST /api/v1/admin/escrow/pause ────────────────────────────────────────

describe("POST /api/v1/admin/escrow/pause — MFA step-up", () => {
  afterEach(() => {
    escrowMigrationState.setPaused(false);
  });

  it("returns 401 Missing MFA challenge without the header", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/escrow/pause")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .send({ paused: true });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
    expect(escrowMigrationState.isPaused()).toBe(false);
  });

  it("returns 403 with another user's challenge", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/escrow/pause")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("someone-else"))
      .send({ paused: true });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
    expect(escrowMigrationState.isPaused()).toBe(false);
  });

  it("returns 401 when the challenge is older than mfaFreshnessMs", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/escrow/pause")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("admin-1", { ageMs: STALE_AGE_MS }))
      .send({ paused: true });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: "MFA challenge has expired; please verify again",
    });
    expect(escrowMigrationState.isPaused()).toBe(false);
  });

  it("pauses escrow with a fresh challenge for the same subject", async () => {
    const res = await request(adminApp)
      .post("/api/v1/admin/escrow/pause")
      .set("x-chronopay-user-id", "admin-1")
      .set("x-chronopay-role", "admin")
      .set("x-chronopay-mfa", await challengeFor("admin-1"))
      .send({ paused: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, paused: true });
  });
});

// ─── POST /api/v1/booking-intents/:id/refund ────────────────────────────────

describe("POST /api/v1/booking-intents/:id/refund — MFA step-up", () => {
  let intentRepo: InMemoryBookingIntentRepository;
  let bookingApp: express.Express;

  const refundBody = { cancelledAtMs: 400, reason: "customer_cancel" };

  function buildBookingApp(): void {
    intentRepo = new InMemoryBookingIntentRepository();
    bookingApp = express();
    bookingApp.use(express.json());
    bookingApp.use(featureFlagContextMiddleware);
    bookingApp.use(
      "/api/v1/booking-intents",
      createBookingIntentsRouter({ bookingIntentRepository: intentRepo }),
    );
  }

  async function seedRefundableIntent(customerId: string): Promise<BookingIntentRecord> {
    return intentRepo.create({
      slotId: `slot-${customerId}`,
      professional: "pro-1",
      customerId,
      startTime: 0,
      endTime: 1000,
      status: "confirmed",
      createdAt: new Date().toISOString(),
      pricingSnapshot: {
        strategyId: "fixed",
        resolvedPrice: 1000,
        basePrice: 1000,
        slotStartMs: 0,
        nowMs: 0,
        activeBookings: 1,
        capacity: 1,
        config: { strategy: "fixed" },
      },
    });
  }

  function refundRequest(intentId: string) {
    return request(bookingApp)
      .post(`/api/v1/booking-intents/${intentId}/refund`)
      .set("x-chronopay-user-id", "user1")
      .set("x-chronopay-role", "customer");
  }

  beforeEach(() => {
    process.env.FF_CREATE_BOOKING_INTENT = "true";
    delete process.env.MFA_REQUIRED_FOR_REFUNDS;
    setFeatureFlagsFromEnv(process.env);
    configService.refresh();
    buildBookingApp();
  });

  afterEach(() => {
    delete process.env.MFA_REQUIRED_FOR_REFUNDS;
    delete process.env.FF_CREATE_BOOKING_INTENT;
    setFeatureFlagsFromEnv(process.env);
    configService.refresh();
  });

  it("does not require a challenge when MFA_REQUIRED_FOR_REFUNDS is disabled", async () => {
    process.env.MFA_REQUIRED_FOR_REFUNDS = "false";
    configService.refresh();
    const intent = await seedRefundableIntent("user1");

    const res = await refundRequest(intent.id).send(refundBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.refund.refundAmountCents).toBe(600);
  });

  describe("with MFA_REQUIRED_FOR_REFUNDS enabled", () => {
    beforeEach(async () => {
      process.env.MFA_REQUIRED_FOR_REFUNDS = "true";
      configService.refresh();
      await flushConfig();
    });

    it("returns 401 Missing MFA challenge without the header", async () => {
      const intent = await seedRefundableIntent("user1");

      const res = await refundRequest(intent.id).send(refundBody);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: "Missing MFA challenge" });
    });

    it("returns 403 with another user's challenge", async () => {
      const intent = await seedRefundableIntent("user1");

      const res = await refundRequest(intent.id)
        .set("x-chronopay-mfa", await challengeFor("someone-else"))
        .send(refundBody);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ success: false, error: "Invalid MFA challenge" });
    });

    it("returns 401 when the challenge is older than mfaFreshnessMs", async () => {
      const intent = await seedRefundableIntent("user1");

      const res = await refundRequest(intent.id)
        .set("x-chronopay-mfa", await challengeFor("user1", { ageMs: STALE_AGE_MS }))
        .send(refundBody);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: "MFA challenge has expired; please verify again",
      });
    });

    it("refunds with a fresh challenge for the same subject", async () => {
      const intent = await seedRefundableIntent("user1");

      const res = await refundRequest(intent.id)
        .set("x-chronopay-mfa", await challengeFor("user1"))
        .send(refundBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.refund.refundAmountCents).toBe(600);
      expect(res.body.refund.reason).toBe("customer_cancel");
    });
  });
});

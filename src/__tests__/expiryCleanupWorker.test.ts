import { jest } from "@jest/globals";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { CheckoutSessionService } from "../services/checkout.js";
import { cleanupExpiryOnce, runExpiryCleanupWorker } from "../scheduler/expiryCleanupWorker.js";
import { register } from "../metrics.js";

const DEFAULT_PAYMENT = {
  amount: 1000,
  currency: "USD",
  paymentMethod: "card",
};

const DEFAULT_CUSTOMER = { customerId: "customer-1" };

async function metricValue(metric: string): Promise<number> {
  const metrics = await register.metrics();
  const line = metrics.split("\n").find((entry) => entry.startsWith(metric));
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).at(-1));
}

describe("expiry cleanup worker", () => {
  const baseTime = 1_700_000_000_000;
  let bookingIntentRepo: InMemoryBookingIntentRepository;
  let slotRepo: InMemorySlotRepository;
  let bookingIntentService: BookingIntentService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(baseTime);
    bookingIntentRepo = new InMemoryBookingIntentRepository();
    slotRepo = new InMemorySlotRepository();
    bookingIntentService = new BookingIntentService(
      bookingIntentRepo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    CheckoutSessionService.clearAllSessions();
    register.resetMetrics();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("expires stale booking intents and releases the associated slot", async () => {
    const intent = await bookingIntentService.createIntent(
      { slotId: "slot-11111111-1111-4111-8111-111111111111" },
      { userId: "customer-1", role: "customer" },
    );

    const result = await cleanupExpiryOnce(
      {
        bookingIntentService,
        bookingIntentRepository: bookingIntentRepo,
      },
      { bookingIntentTTLms: 60_000 },
      baseTime + 60_000 + 1,
    );

    expect(result.expiredIntents).toBe(1);
    expect(result.softExpiredSessions).toBe(0);
    expect(result.deletedSessions).toBe(0);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
    expect(slotRepo.findById(intent.slotId)?.bookable).toBe(true);
    expect(await metricValue("expiry_cleanup_booking_intents_expired_total")).toBe(1);
  });

  it("soft-expires pending sessions and deletes orphaned sessions after grace", async () => {
    const pending = CheckoutSessionService.createSession({
      payment: DEFAULT_PAYMENT,
      customer: DEFAULT_CUSTOMER,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    const expired = CheckoutSessionService.createSession({
      payment: DEFAULT_PAYMENT,
      customer: DEFAULT_CUSTOMER,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    const pendingSession = CheckoutSessionService.getSessionById(pending.id);
    const expiredSession = CheckoutSessionService.getSessionById(expired.id);
    expect(pendingSession).toBeDefined();
    expect(expiredSession).toBeDefined();

    if (!pendingSession || !expiredSession) {
      throw new Error("Unable to seed sessions");
    }

    pendingSession.expiresAt = Math.floor((baseTime - 1000) / 1000);
    CheckoutSessionService.persistSession(pendingSession);

    expiredSession.status = "completed";
    expiredSession.expiresAt = Math.floor((baseTime - 3_600_000 - 1000) / 1000);
    CheckoutSessionService.persistSession(expiredSession);

    const result = await cleanupExpiryOnce(
      {
        bookingIntentService,
        bookingIntentRepository: bookingIntentRepo,
      },
      { sessionSoftExpiryGraceMs: 3_600_000, bookingIntentTTLms: 60_000 },
      baseTime,
    );

    expect(result.expiredIntents).toBe(0);
    expect(result.softExpiredSessions).toBe(1);
    expect(result.deletedSessions).toBe(1);
    expect(CheckoutSessionService.getSessionById(pending.id)?.status).toBe("expired");
    expect(CheckoutSessionService.getSessionById(expired.id)).toBeUndefined();
    expect(await metricValue("expiry_cleanup_checkout_sessions_soft_expired_total")).toBe(1);
    expect(await metricValue("expiry_cleanup_checkout_sessions_deleted_total")).toBe(1);
  });

  it("skips cleanup when candidate sweep size exceeds safety threshold", async () => {
    const sessionIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const session = CheckoutSessionService.createSession({
        payment: DEFAULT_PAYMENT,
        customer: DEFAULT_CUSTOMER,
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      });
      sessionIds.push(session.id);
    }

    for (const sessionId of sessionIds) {
      const stored = CheckoutSessionService.getSessionById(sessionId);
      if (!stored) throw new Error("session missing");
      stored.status = "failed";
      stored.expiresAt = Math.floor((baseTime - 1000) / 1000);
      CheckoutSessionService.persistSession(stored);
    }

    const result = await cleanupExpiryOnce(
      {
        bookingIntentService,
        bookingIntentRepository: bookingIntentRepo,
      },
      { safetyThreshold: 4, sessionSoftExpiryGraceMs: 1 },
      baseTime,
    );

    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.expiredIntents).toBe(0);
    expect(CheckoutSessionService.getSessionCount()).toBe(5);
    expect(await metricValue("expiry_cleanup_safety_brake_triggers_total")).toBe(1);
  });

  it("stops gracefully when aborted mid-run", async () => {
    const intent = await bookingIntentService.createIntent(
      { slotId: "slot-11111111-1111-4111-8111-111111111111" },
      { userId: "customer-1", role: "customer" },
    );
    jest.setSystemTime(baseTime + 1_000_000);

    const abortController = new AbortController();
    const workerPromise = runExpiryCleanupWorker(
      abortController.signal,
      {
        bookingIntentService,
        bookingIntentRepository: bookingIntentRepo,
      },
      { intervalMs: 1000, bookingIntentTTLms: 1 },
    );

    await Promise.resolve();
    abortController.abort();
    await expect(workerPromise).resolves.toBeUndefined();
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });
});

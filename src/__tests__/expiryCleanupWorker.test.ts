// @ts-nocheck
import { jest } from "@jest/globals";
import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import {
  chunk,
  cleanupExpiryOnce,
  runExpiryCleanupWorker,
  type CheckoutSessionCleanupService,
  type ExpiryCleanupDependencies,
} from "../scheduler/expiryCleanupWorker.js";
import {
  CheckoutSessionStatus,
  type CheckoutSession,
} from "../types/checkout.js";
import { register } from "../metrics.js";

const DEFAULT_PAYMENT = {
  amount: 1000,
  currency: "USD",
  paymentMethod: "credit_card",
};

const DEFAULT_CUSTOMER = {
  customerId: "customer-1",
  email: "customer@example.com",
};

class InMemoryCheckoutSessionCleanupService implements CheckoutSessionCleanupService {
  private readonly sessions = new Map<string, CheckoutSession>();
  private sequence = 1;

  createSession(status: CheckoutSessionStatus = CheckoutSessionStatus.PENDING): CheckoutSession {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const session: CheckoutSession = {
      id: `session-${this.sequence++}`,
      payment: DEFAULT_PAYMENT,
      customer: DEFAULT_CUSTOMER,
      status,
      createdAt: nowSeconds,
      expiresAt: nowSeconds + 24 * 60 * 60,
      updatedAt: nowSeconds,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  listSessionBatch(batchSize: number, cursor?: string): {
    sessions: CheckoutSession[];
    nextCursor?: string;
  } {
    const allSessions = Array.from(this.sessions.values());
    const offset = cursor === undefined ? 0 : Number(cursor);
    const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : allSessions.length;
    const sessions = allSessions.slice(offset, offset + size);
    const nextOffset = offset + sessions.length;
    return {
      sessions,
      nextCursor: nextOffset < allSessions.length ? String(nextOffset) : undefined,
    };
  }

  getSessionById(sessionId: string): CheckoutSession | undefined {
    return this.sessions.get(sessionId);
  }

  persistSession(session: CheckoutSession): void {
    this.sessions.set(session.id, session);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}

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
  let checkoutSessionService: InMemoryCheckoutSessionCleanupService;
  let dependencies: ExpiryCleanupDependencies;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(baseTime);
    bookingIntentRepo = new InMemoryBookingIntentRepository();
    slotRepo = new InMemorySlotRepository();
    bookingIntentService = new BookingIntentService(
      bookingIntentRepo,
      slotRepo,
      () => new Date(baseTime).toISOString(),
    );
    checkoutSessionService = new InMemoryCheckoutSessionCleanupService();
    dependencies = {
      bookingIntentService,
      bookingIntentRepository: bookingIntentRepo,
      checkoutSessionService,
    };
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
      dependencies,
      { bookingIntentTTLms: 60_000 },
      baseTime + 60_000 + 1,
    );

    expect(result.expiredIntents).toBe(1);
    expect(result.softExpiredSessions).toBe(0);
    expect(result.deletedSessions).toBe(0);
    expect(result.skippedBecauseThreshold).toBe(false);
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
    expect(slotRepo.findById(intent.slotId)?.bookable).toBe(true);
    expect(await metricValue("expiry_cleanup_booking_intents_expired_total")).toBe(1);
  });

  it("stores checkout session expiry as a Unix timestamp in seconds", () => {
    const session = checkoutSessionService.createSession();
    expect(session.expiresAt * 1000).toBe(baseTime + 24 * 60 * 60 * 1000);
  });

  it("soft-expires pending sessions and deletes orphaned sessions after grace", async () => {
    const pending = checkoutSessionService.createSession();
    const expired = checkoutSessionService.createSession(CheckoutSessionStatus.COMPLETED);

    const pendingSession = checkoutSessionService.getSessionById(pending.id);
    const expiredSession = checkoutSessionService.getSessionById(expired.id);

    if (!pendingSession || !expiredSession) {
      throw new Error("Unable to seed sessions");
    }

    pendingSession.expiresAt = Math.floor((baseTime - 1000) / 1000);
    checkoutSessionService.persistSession(pendingSession);

    expiredSession.status = CheckoutSessionStatus.COMPLETED;
    expiredSession.expiresAt = Math.floor((baseTime - 3_600_000 - 1000) / 1000);
    checkoutSessionService.persistSession(expiredSession);

    const result = await cleanupExpiryOnce(
      dependencies,
      { sessionSoftExpiryGraceMs: 3_600_000, bookingIntentTTLms: 60_000 },
      baseTime,
    );

    expect(result.expiredIntents).toBe(0);
    expect(result.softExpiredSessions).toBe(1);
    expect(result.deletedSessions).toBe(1);
    expect(result.skippedBecauseThreshold).toBe(false);
    expect(checkoutSessionService.getSessionById(pending.id)?.status).toBe(CheckoutSessionStatus.EXPIRED);
    expect(checkoutSessionService.getSessionById(expired.id)).toBeUndefined();
    expect(await metricValue("expiry_cleanup_checkout_sessions_soft_expired_total")).toBe(1);
    expect(await metricValue("expiry_cleanup_checkout_sessions_deleted_total")).toBe(1);
  });

  it("skips cleanup when candidate sweep size exceeds safety threshold", async () => {
    for (let i = 0; i < 5; i += 1) {
      const stored = checkoutSessionService.createSession(CheckoutSessionStatus.FAILED);
      stored.status = CheckoutSessionStatus.FAILED;
      stored.expiresAt = Math.floor((baseTime - 1000) / 1000);
      checkoutSessionService.persistSession(stored);
    }

    const result = await cleanupExpiryOnce(
      dependencies,
      { safetyThreshold: 4, sessionSoftExpiryGraceMs: 1 },
      baseTime,
    );

    expect(result.skippedBecauseThreshold).toBe(true);
    expect(result.expiredIntents).toBe(0);
    expect(checkoutSessionService.getSessionCount()).toBe(5);
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
      dependencies,
      { intervalMs: 1000, bookingIntentTTLms: 1 },
    );

    await Promise.resolve();
    abortController.abort();
    await expect(workerPromise).resolves.toBeUndefined();
    expect(bookingIntentRepo.findById(intent.id)?.status).toBe("expired");
  });

  it("chunks all items once when the requested size is non-positive", () => {
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
    expect(chunk([1, 2, 3], -1)).toEqual([[1, 2, 3]]);
  });
});

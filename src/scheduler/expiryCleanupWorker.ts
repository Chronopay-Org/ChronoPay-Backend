import { BookingIntentService } from "../modules/booking-intents/booking-intent-service.js";
import type { BookingIntentRecord, BookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { CheckoutSessionService } from "../services/checkout.js";
import {
  expiryCleanupBookingIntentsExpired,
  expiryCleanupCheckoutSessionsDeleted,
  expiryCleanupCheckoutSessionsSoftExpired,
  expiryCleanupSafetyBrakeTriggers,
} from "../metrics.js";

export interface ExpiryCleanupWorkerConfig {
  bookingIntentTTLms?: number;
  sessionSoftExpiryGraceMs?: number;
  batchSize?: number;
  safetyThreshold?: number;
  intervalMs?: number;
}

export interface ExpiryCleanupResult {
  expiredIntents: number;
  softExpiredSessions: number;
  deletedSessions: number;
  skippedBecauseThreshold?: boolean;
}

const DEFAULT_CONFIG = {
  bookingIntentTTLms: 15 * 60 * 1000, // 15 minutes
  sessionSoftExpiryGraceMs: 60 * 60 * 1000, // 1 hour
  batchSize: 100,
  safetyThreshold: 1_000,
  intervalMs: 5 * 60 * 1000, // 5 minutes
};

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultValue;
  }
  return parsed;
}

function resolveConfig(overrides: ExpiryCleanupWorkerConfig = {}): Required<ExpiryCleanupWorkerConfig> {
  return {
    bookingIntentTTLms:
      overrides.bookingIntentTTLms ?? parsePositiveInteger(process.env.BOOKING_INTENT_TTL_MS, DEFAULT_CONFIG.bookingIntentTTLms),
    sessionSoftExpiryGraceMs:
      overrides.sessionSoftExpiryGraceMs ?? parsePositiveInteger(process.env.EXPIRY_SOFT_EXPIRY_GRACE_MS, DEFAULT_CONFIG.sessionSoftExpiryGraceMs),
    batchSize:
      overrides.batchSize ?? parsePositiveInteger(process.env.EXPIRY_CLEANUP_BATCH_SIZE, DEFAULT_CONFIG.batchSize),
    safetyThreshold:
      overrides.safetyThreshold ?? parsePositiveInteger(process.env.EXPIRY_CLEANUP_SAFETY_THRESHOLD, DEFAULT_CONFIG.safetyThreshold),
    intervalMs:
      overrides.intervalMs ?? parsePositiveInteger(process.env.EXPIRY_CLEANUP_INTERVAL_MS, DEFAULT_CONFIG.intervalMs),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

interface CleanupDependencies {
  bookingIntentService: BookingIntentService;
  bookingIntentRepository: BookingIntentRepository;
}

export async function cleanupExpiryOnce(
  dependencies: CleanupDependencies,
  configOverrides: ExpiryCleanupWorkerConfig = {},
  nowMs?: number,
): Promise<ExpiryCleanupResult> {
  const config = resolveConfig(configOverrides);
  const now = nowMs ?? Date.now();
  const cutoffForIntents = now - config.bookingIntentTTLms;

  const staleIntents = dependencies.bookingIntentRepository
    .listAll()
    .filter((intent) => intent.status === "pending")
    .filter((intent) => new Date(intent.createdAt).getTime() <= cutoffForIntents);

  let softExpiredSessions = 0;
  let deletedSessions = 0;
  const candidateSessionIds: string[] = [];
  let sessionCursor: string | undefined;

  do {
    const { sessions, nextCursor } = CheckoutSessionService.listSessionBatch(config.batchSize, sessionCursor);
    for (const session of sessions) {
      const sessionExpiryMs = session.expiresAt * 1000;
      if (session.status === "pending" && now >= sessionExpiryMs) {
        candidateSessionIds.push(session.id);
      } else if (session.status !== "pending" && now >= sessionExpiryMs + config.sessionSoftExpiryGraceMs) {
        candidateSessionIds.push(session.id);
      }
    }
    sessionCursor = nextCursor;
  } while (sessionCursor);

  const candidateCount = staleIntents.length + candidateSessionIds.length;
  if (candidateCount > config.safetyThreshold) {
    expiryCleanupSafetyBrakeTriggers.inc();
    return {
      expiredIntents: 0,
      softExpiredSessions: 0,
      deletedSessions: 0,
      skippedBecauseThreshold: true,
    };
  }

  const expiredIntents = staleIntents.length;
  for (const intent of staleIntents) {
    dependencies.bookingIntentService.expireIntent(intent.id);
  }

  const sessionChunks = chunk(candidateSessionIds, config.batchSize);
  for (const batch of sessionChunks) {
    for (const sessionId of batch) {
      const session = CheckoutSessionService.getSessionById(sessionId);
      if (!session) {
        continue;
      }

      const sessionExpiryMs = session.expiresAt * 1000;
      if (session.status === "pending" && now >= sessionExpiryMs) {
        session.status = "expired";
        session.updatedAt = Math.floor(now / 1000);
        CheckoutSessionService.persistSession(session);
        softExpiredSessions += 1;
      } else if (session.status !== "pending" && now >= sessionExpiryMs + config.sessionSoftExpiryGraceMs) {
        CheckoutSessionService.deleteSession(sessionId);
        deletedSessions += 1;
      }
    }
  }

  if (expiredIntents > 0) {
    expiryCleanupBookingIntentsExpired.inc(expiredIntents);
  }

  if (softExpiredSessions > 0) {
    expiryCleanupCheckoutSessionsSoftExpired.inc(softExpiredSessions);
  }

  if (deletedSessions > 0) {
    expiryCleanupCheckoutSessionsDeleted.inc(deletedSessions);
  }

  return { expiredIntents, softExpiredSessions, deletedSessions };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      return resolve();
    }

    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runExpiryCleanupWorker(
  signal: AbortSignal,
  dependencies: CleanupDependencies,
  configOverrides: ExpiryCleanupWorkerConfig = {},
): Promise<void> {
  const config = resolveConfig(configOverrides);

  while (!signal.aborted) {
    await cleanupExpiryOnce(dependencies, configOverrides);
    if (signal.aborted) {
      break;
    }
    await sleep(config.intervalMs, signal);
  }
}

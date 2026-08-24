/**
 * Anomaly scoring for booking-intents (issue #596).
 *
 * Computes a simple, explainable anomaly score in the range [0, 1] for every
 * booking-intent creation request from four normalized risk signals:
 *
 *  1. `velocity`          – number of intents the customer created inside a
 *                           recent time window (from persisted intent history).
 *  2. `fingerprintRisk`   – device-fingerprint evidence: unseen devices are a
 *                           mild signal, fingerprints shared across different
 *                           customers are a strong sockpuppet signal.
 *  3. `geoHopDistance`    – great-circle distance between the customer's last
 *                           observed location and the current one. Impossible
 *                           travel ("extreme geo hop") scores highest.
 *  4. `buyerAge`          – age of the buyer derived either from the account
 *                           creation timestamp or their earliest booking
 *                           intent; accounts younger than a day score highest.
 *
 * Every signal is normalized to [0, 1] and defaults to **0 when its input is
 * missing** — absent evidence must never inflate risk. The overall score is a
 * fixed-weight combination of the four signals and an intent is flagged for
 * review when `score > flagThreshold` (default 0.7).
 *
 * Privacy: raw device fingerprints are never persisted — only a SHA-256 hash
 * is kept, mirroring `fraudScorer.ts`. The default IP→location resolver maps
 * IPs to deterministic pseudo-coordinates so that "same network location"
 * comparisons remain consistent without shipping a GeoIP database; production
 * deployments should inject a real GeoIP resolver via `resolveLocation`.
 *
 * State retention: fingerprint/location indexes are per-process and bounded;
 * velocity and buyer-age signals are derived from caller-supplied history so
 * they survive restarts. See docs/anomaly-scoring.md.
 */

import { createHash } from "node:crypto";
import { greatCircleDistance } from "h3-js";

export interface IpLocation {
  lat: number;
  lng: number;
}

/** Resolves an IP address to a geographic location, or undefined if unknown. */
export type IpLocationResolver = (ip: string) => IpLocation | undefined;

export interface AnomalySignals {
  velocity: number;
  fingerprintRisk: number;
  geoHopDistance: number;
  buyerAge: number;
}

export interface AnomalyAssessment {
  score: number;
  signals: AnomalySignals;
  /** True when score exceeds the configured flag threshold (strictly). */
  flagged: boolean;
  /** Human-readable reasons contributing to the assessment (for review UIs). */
  reasons: string[];
}

export interface AnomalyEvaluateInput {
  customerId: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  /** Number of intents the customer created within the scorer's velocity window. */
  recentIntentCount?: number;
  /** Creation timestamp (ISO string or epoch ms) of the customer's earliest intent. */
  firstIntentAt?: string | number;
  /** Account creation epoch ms, when known. Takes precedence over `firstIntentAt`. */
  customerSinceMs?: number;
}

export interface AnomalyScorerOptions {
  velocityWindowMs?: number;
  /** Intent count (beyond the first) that saturates the velocity signal. */
  velocityBurstCount?: number;
  flagThreshold?: number;
  weights?: Partial<AnomalySignals>;
  maxTrackedCustomers?: number;
  maxTrackedFingerprints?: number;
  resolveLocation?: IpLocationResolver;
  nowMs?: () => number;
}

export const DEFAULT_VELOCITY_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_VELOCITY_BURST_COUNT = 4;
export const DEFAULT_FLAG_THRESHOLD = 0.7;

const DEFAULT_WEIGHTS: AnomalySignals = {
  velocity: 0.35,
  fingerprintRisk: 0.2,
  geoHopDistance: 0.3,
  buyerAge: 0.15,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * Deterministic default resolver: maps an IP to stable pseudo-coordinates via
 * SHA-256. Consistent for identical inputs (so repeated requests from the same
 * network never produce phantom hops) but NOT real geolocation.
 */
export const pseudoLocationResolver: IpLocationResolver = (ip) => {
  if (!ip || ip.trim().length === 0) return undefined;
  const digest = createHash("sha256").update(ip.trim()).digest("hex");
  const lat = (parseInt(digest.slice(0, 8), 16) / 0xffffffff) * 180 - 90;
  const lng = (parseInt(digest.slice(8, 16), 16) / 0xffffffff) * 360 - 180;
  return { lat, lng };
};

/** Normalized velocity risk from a recent-intent count. First intent is free. */
export function computeVelocitySignal(
  recentIntentCount: number | undefined,
  burstCount: number,
): number {
  const count =
    typeof recentIntentCount === "number" && Number.isFinite(recentIntentCount)
      ? Math.max(0, Math.floor(recentIntentCount))
      : 0;
  if (count <= 1) return 0;
  return Math.min((count - 1) / burstCount, 1);
}

/** Normalized buyer-age risk. Unknown age yields 0 (absence of evidence). */
export function computeBuyerAgeSignal(
  input: Pick<AnomalyEvaluateInput, "customerSinceMs" | "firstIntentAt">,
  nowMs: number,
): { signal: number; reason?: string } {
  let sinceMs: number | undefined;
  if (typeof input.customerSinceMs === "number" && Number.isFinite(input.customerSinceMs)) {
    sinceMs = input.customerSinceMs;
  } else if (input.firstIntentAt !== undefined) {
    const parsed =
      typeof input.firstIntentAt === "number"
        ? input.firstIntentAt
        : new Date(input.firstIntentAt).getTime();
    if (Number.isFinite(parsed)) sinceMs = parsed;
  }

  if (sinceMs === undefined || sinceMs > nowMs) return { signal: 0 };

  const ageDays = (nowMs - sinceMs) / MS_PER_DAY;
  if (ageDays < 1) return { signal: 1, reason: "account_age_lt_1d" };
  if (ageDays <= 7) return { signal: 0.5, reason: "account_age_lt_7d" };
  if (ageDays <= 30) return { signal: 0.2, reason: "account_age_lt_30d" };
  return { signal: 0 };
}

/** Normalized geo-hop risk from a great-circle distance in km. */
export function computeGeoHopSignal(distanceKm: number): number {
  if (distanceKm < 50) return 0;
  if (distanceKm < 500) return 0.3;
  if (distanceKm < 3000) return 0.7;
  return 1;
}

export class AnomalyScorer {
  private readonly velocityWindowMs: number;
  private readonly velocityBurstCount: number;
  private readonly flagThreshold: number;
  private readonly weights: AnomalySignals;
  private readonly maxTrackedCustomers: number;
  private readonly maxTrackedFingerprints: number;
  private readonly resolveLocation: IpLocationResolver;
  private readonly nowMs: () => number;

  /** fingerprint hash -> customers seen using it (in-process only). */
  private readonly fingerprintIndex = new Map<string, Set<string>>();
  /** customerId -> last observed location (in-process only). */
  private readonly lastLocationByCustomer = new Map<string, IpLocation>();

  constructor(options: AnomalyScorerOptions = {}) {
    this.velocityWindowMs =
      options.velocityWindowMs ??
      readPositiveIntEnv("ANOMALY_VELOCITY_WINDOW_MS", DEFAULT_VELOCITY_WINDOW_MS);
    this.velocityBurstCount =
      options.velocityBurstCount ??
      readPositiveIntEnv("ANOMALY_VELOCITY_BURST_COUNT", DEFAULT_VELOCITY_BURST_COUNT);
    this.flagThreshold =
      options.flagThreshold ??
      (() => {
        const raw = Number(process.env.ANOMALY_FLAG_THRESHOLD);
        return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_FLAG_THRESHOLD;
      })();
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    // Index capacities are clamped to >= 1: an unbounded or zero-capacity
    // index would silently defeat the FIFO bound (memory-exhaustion guard).
    this.maxTrackedCustomers = Math.max(1, options.maxTrackedCustomers ?? 10_000);
    this.maxTrackedFingerprints = Math.max(1, options.maxTrackedFingerprints ?? 20_000);
    this.resolveLocation = options.resolveLocation ?? pseudoLocationResolver;
    this.nowMs = options.nowMs ?? Date.now;
  }

  getFlagThreshold(): number {
    return this.flagThreshold;
  }

  getVelocityWindowMs(): number {
    return this.velocityWindowMs;
  }

  /** Current time per the scorer's (possibly injected) clock. */
  getNowMs(): number {
    return this.nowMs();
  }

  /**
   * Evaluate one booking-intent creation. Indexes are updated only after the
   * signals are computed, so a first-ever request never compares against
   * itself.
   */
  evaluate(input: AnomalyEvaluateInput): AnomalyAssessment {
    const reasons: string[] = [];
    const now = this.nowMs();

    const velocity = computeVelocitySignal(input.recentIntentCount, this.velocityBurstCount);
    if (velocity > 0) {
      reasons.push(`velocity_burst:${input.recentIntentCount}`);
    }

    const fingerprint = this.evaluateFingerprint(input, reasons);

    const geo = this.evaluateGeoHop(input, reasons);

    const age = computeBuyerAgeSignal(input, now);
    if (age.reason) reasons.push(age.reason);

    const score = this.clamp01(
      velocity * this.weights.velocity +
        fingerprint * this.weights.fingerprintRisk +
        geo * this.weights.geoHopDistance +
        age.signal * this.weights.buyerAge,
    );

    return {
      score,
      signals: {
        velocity,
        fingerprintRisk: fingerprint,
        geoHopDistance: geo,
        buyerAge: age.signal,
      },
      flagged: score > this.flagThreshold,
      reasons,
    };
  }

  private evaluateFingerprint(input: AnomalyEvaluateInput, reasons: string[]): number {
    const raw = input.deviceFingerprint?.trim();
    if (!raw) return 0;

    const hash = createHash("sha256").update(raw.toLowerCase()).digest("hex");
    const owners = this.fingerprintIndex.get(hash);
    let signal: number;

    if (!owners) {
      // Unseen device — mild signal on its own.
      signal = 0.25;
      reasons.push("unrecognized_device_fingerprint");
    } else if (owners.has(input.customerId) && owners.size === 1) {
      signal = 0;
    } else {
      // Fingerprint already used by a different customer — strong signal.
      signal = 1;
      reasons.push("shared_device_fingerprint");
    }

    this.trackFingerprint(hash, input.customerId);
    return signal;
  }

  private trackFingerprint(hash: string, customerId: string): void {
    let owners = this.fingerprintIndex.get(hash);
    if (!owners) {
      while (this.fingerprintIndex.size >= this.maxTrackedFingerprints) {
        const oldest = this.fingerprintIndex.keys().next().value;
        if (oldest === undefined) break;
        this.fingerprintIndex.delete(oldest);
      }
      owners = new Set();
      this.fingerprintIndex.set(hash, owners);
    }
    owners.add(customerId);
  }

  private evaluateGeoHop(input: AnomalyEvaluateInput, reasons: string[]): number {
    const ip = input.ipAddress?.trim();
    if (!ip) return 0;

    const current = this.resolveLocation(ip);
    if (!current) return 0;

    const previous = this.lastLocationByCustomer.get(input.customerId);

    while (this.lastLocationByCustomer.size >= this.maxTrackedCustomers) {
      const oldest = this.lastLocationByCustomer.keys().next().value;
      if (oldest === undefined) break;
      this.lastLocationByCustomer.delete(oldest);
    }
    this.lastLocationByCustomer.set(input.customerId, current);

    if (!previous) return 0;

    const distanceKm = greatCircleDistance(
      [previous.lat, previous.lng],
      [current.lat, current.lng],
      "km",
    ) as number;
    const signal = computeGeoHopSignal(distanceKm);
    if (signal >= 0.7) {
      reasons.push(`geo_hop:${Math.round(distanceKm)}km`);
    }
    return signal;
  }

  private clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  /** Test hook — clears all in-process state. */
  _reset(): void {
    this.fingerprintIndex.clear();
    this.lastLocationByCustomer.clear();
  }
}

export interface AnomalyReviewItem {
  id: string;
  intentId: string;
  customerId: string;
  score: number;
  signals: AnomalySignals;
  reasons: string[];
  flaggedAt: string;
}

const MAX_REVIEW_QUEUE_ITEMS = 1000;

/**
 * Bounded in-memory queue of flagged intents surfaced through
 * `GET /api/v1/admin/anomaly-queue`. Mirrors the `fraudReviewQueue` pattern:
 * process-local, reset between tests, safe drop-oldest under pressure.
 */
class AnomalyReviewQueue {
  private readonly items = new Map<string, AnomalyReviewItem>();
  private sequence = 0;

  enqueue(intentId: string, customerId: string, assessment: AnomalyAssessment): AnomalyReviewItem {
    const item: AnomalyReviewItem = {
      id: `anomaly-${Date.now()}-${++this.sequence}`,
      intentId,
      customerId,
      score: assessment.score,
      signals: assessment.signals,
      reasons: assessment.reasons,
      flaggedAt: new Date().toISOString(),
    };

    while (this.items.size >= MAX_REVIEW_QUEUE_ITEMS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }

    this.items.set(item.id, item);
    return item;
  }

  listAll(): AnomalyReviewItem[] {
    return Array.from(this.items.values());
  }

  getItem(id: string): AnomalyReviewItem | undefined {
    return this.items.get(id);
  }

  _reset(): void {
    this.items.clear();
    this.sequence = 0;
  }
}

export const anomalyReviewQueue = new AnomalyReviewQueue();

/** Minimal structural view of persisted intent history used for scoring. */
export interface AnomalyHistoryEntry {
  createdAt: string;
}

export interface AnomalyHistoryProvider {
  listByCustomer(customerId: string): Promise<AnomalyHistoryEntry[]> | AnomalyHistoryEntry[];
}

export interface AnomalyRequestContext {
  customerId: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}

/**
 * Gathers persisted-history signals (velocity-window count, earliest intent)
 * for a customer and evaluates the scorer. Used by both booking-intent create
 * handlers so they stay behaviorally identical. A history lookup failure is
 * logged and degrades those signals to 0 rather than blocking creation.
 */
export async function assessBookingIntentAnomaly(
  scorer: AnomalyScorer,
  historyProvider: AnomalyHistoryProvider | undefined,
  context: AnomalyRequestContext,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<AnomalyAssessment> {
  let recentIntentCount: number | undefined;
  let firstIntentAt: string | undefined;

  try {
    const entries = historyProvider ? await historyProvider.listByCustomer(context.customerId) : [];
    if (entries && entries.length > 0) {
      const windowMs = scorer.getVelocityWindowMs();
      const nowMs = scorer.getNowMs();
      recentIntentCount = entries.filter(
        (entry) => nowMs - new Date(entry.createdAt).getTime() <= windowMs,
      ).length;
      firstIntentAt = entries.reduce(
        (earliest, entry) => (entry.createdAt < earliest ? entry.createdAt : earliest),
        entries[0].createdAt,
      );
    }
  } catch (err) {
    logger?.warn({ err }, "Anomaly history lookup failed; scoring without history");
  }

  return scorer.evaluate({
    customerId: context.customerId,
    ipAddress: context.ipAddress,
    deviceFingerprint: context.deviceFingerprint,
    recentIntentCount,
    firstIntentAt,
  });
}

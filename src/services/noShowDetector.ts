/**
 * noShowDetector.ts
 * ----------------
 * Two-signal no-show detection heuristic.
 *
 * A booking intent is flagged as a potential no-show **only** when two
 * independent signals both indicate the buyer did not attend:
 *   1. GPS check‑in (buyer-side, optional, privacy‑sensitive)
 *   2. Supplier confirmation (provider‑side, explicit)
 *
 * Truth table
 * -----------
 *   GPS check‑in       Supplier confirmed   Result
 *   ─────────────────   ──────────────────   ──────
 *   ✓ within radius     ✓                    NOT no‑show
 *   ✓ within radius     ✗                    NOT no‑show  (GPS proves presence)
 *   ✗ / outside         ✓                    NOT no‑show  (supplier confirms)
 *   ✗ / outside         ✗                    NO‑SHOW      (both negative)
 *   (not submitted)     ✓                    NOT no‑show  (one signal enough)
 *   ✓ within radius     (not submitted)      NOT no‑show  (one signal enough)
 *   untrusted / unknown ✓                    NOT no‑show  (supplier confirms)
 *   (not submitted)     ✗                    INSUFFICIENT (only one negative)
 *   ✗ / outside         (not submitted)      INSUFFICIENT (only one negative)
 *   untrusted / unknown ✗                    INSUFFICIENT (only one negative)
 *   untrusted / unknown (not submitted)      INSUFFICIENT (only one negative)
 *   (not submitted)     (not submitted)      INSUFFICIENT (no data)
 *
 * Penalty is only applied when `isNoShow === true` — both signals were
 * received and both independently indicate absence.
 *
 * Privacy
 * -------
 * GPS coordinates are never persisted as plaintext beyond the evaluation
 * window. The detector stores an HMAC‑SHA‑256 of the coordinate pair
 * plus slot ID for auditability without retaining geolocation data.
 */

import { createHmac } from "crypto";
import { logger } from "../utils/logger.js";
import { defaultAuditLogger } from "./auditLogger.js";

/* ─── Public types ────────────────────────────────────────────────────────── */

/** GPS coordinates (WGS84) */
export interface GpsCoordinates {
  latitude: number;
  longitude: number;
}

/** A buyer‑submitted GPS check‑in for a specific booking intent. */
export interface GpsCheckIn {
  /** Booking intent this check‑in belongs to. */
  intentId: string;
  /** Human‑readable slot identifier (for cross‑referencing). */
  slotId: string;
  /** Device‑reported coordinates. */
  coordinates: GpsCoordinates;
  /**
   * Reported horizontal accuracy in metres (e.g. from the Geolocation API).
   * Must be ≤ {@link DEFAULT_MAX_GPS_ACCURACY_M} to be trusted.
   */
  accuracyMeters: number;
  /** Unix epoch millisecond timestamp of the check‑in. */
  timestamp: number;
}

/**
 * The expected location of a slot (set by the supplier / professional).
 * Used to determine whether a GPS check‑in is "close enough".
 */
export interface SlotLocation {
  latitude: number;
  longitude: number;
  /** Acceptable radius from the slot location in metres. */
  radiusMeters: number;
}

/** A supplier / professional confirmation regarding buyer attendance. */
export interface SupplierConfirmation {
  /** Booking intent this confirmation belongs to. */
  intentId: string;
  /** Supplier / professional user ID. */
  confirmedBy: string;
  /**
   * Whether the supplier confirms the buyer showed up.
   * `true`  = buyer attended,
   * `false` = supplier explicitly states the buyer did NOT attend.
   */
  confirmed: boolean;
  /** Unix epoch millisecond timestamp of the confirmation. */
  timestamp: number;
}

/** Individual signal state after evaluation. */
export interface SignalState {
  /** Was the signal submitted at all? */
  received: boolean;
  /**
   * For GPS: `true` if within radius, `false` if outside, `null` if not submitted.
   * For supplier: `true` if confirmed present, `false` if confirmed absent,
   *               `null` if not submitted.
   */
  value: boolean | null;
}

/** Result of a no‑show evaluation. */
export interface NoShowEvaluationResult {
  /** True only when both signals were received and both indicate absence. */
  isNoShow: boolean;
  /**
   * True when we cannot reach a definitive conclusion because at least one
   * signal was not submitted while the other indicates absence.
   */
  isInsufficient: boolean;
  /** Confidence score 0–1. Based on how many signals agree. */
  confidence: number;
  /** Per‑signal breakdown. */
  signals: {
    gps: SignalState;
    supplier: SignalState;
  };
  /** Human‑readable reasons for the verdict. */
  reasons: string[];
  /** ISO‑8601 timestamp of evaluation. */
  evaluatedAt: string;
}

/** Structured audit record emitted after every evaluation. */
export interface NoShowAuditRecord {
  intentId: string;
  slotId: string;
  isNoShow: boolean;
  hadGpsCheckIn: boolean;
  hadSupplierConfirmation: boolean;
  gpsWithinRadius: boolean | null;
  supplierConfirmed: boolean | null;
  gpsCoordinateHash: string | null;
  confidence: number;
  evaluatedAt: string;
}

/** Options for the NoShowDetector constructor. */
export interface NoShowDetectorOptions {
  /** Override the maximum acceptable GPS accuracy (default 50 m). */
  maxGpsAccuracyM?: number;
  /** Callback for emitting audit records (default: audit logger). */
  emitAudit?: (record: NoShowAuditRecord) => void;
}

/* ─── Constants ───────────────────────────────────────────────────────────── */

/** Default maximum GPS horizontal accuracy the detector trusts (metres). */
export const DEFAULT_MAX_GPS_ACCURACY_M = 50;

/** Earth's mean radius in metres (Haversine formula). */
const EARTH_RADIUS_M = 6_371_000;

/* ─── Helper: Haversine distance ──────────────────────────────────────────── */

/**
 * Compute the great‑circle distance (metres) between two WGS84 points
 * using the Haversine formula.
 */
function haversineDistance(a: GpsCoordinates, b: GpsCoordinates): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const aVal =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));

  return EARTH_RADIUS_M * c;
}

/**
 * Check whether GPS coordinates are within the expected slot radius.
 *
 * @returns `null` when the check‑in accuracy exceeds the configured max
 *          (we can't trust the reading), otherwise a boolean.
 */
function isWithinRadius(
  checkIn: GpsCoordinates,
  slotLocation: SlotLocation,
  accuracyMeters: number,
  maxAccuracyM: number,
): boolean | null {
  if (accuracyMeters > maxAccuracyM) {
    return null; // Untrusted accuracy — treat as "not a reliable signal"
  }
  const distance = haversineDistance(checkIn, slotLocation);
  return distance <= slotLocation.radiusMeters;
}

/* ─── Helper: coordinate hashing ──────────────────────────────────────────── */

/**
 * Produce a deterministic HMAC‑SHA‑256 of (lat, lon, slotId) using a
 * server‑side secret. Coordinates are never stored in plaintext, but the
 * hash is reproducible by anyone who holds the secret — enabling auditors
 * to verify location claims without retaining geolocation data.
 */
function hashCoordinates(
  lat: number,
  lon: number,
  slotId: string,
): string {
  const key =
    process.env.NO_SHOW_HASH_SECRET || "chronopay-noshow-default-secret";
  const payload = `${lat.toFixed(5)}|${lon.toFixed(5)}|${slotId}`;
  return createHmac("sha256", key).update(payload).digest("hex");
}

/* ─── Detector ────────────────────────────────────────────────────────────── */

export class NoShowDetector {
  private readonly maxGpsAccuracyM: number;
  private readonly emitAudit: (record: NoShowAuditRecord) => void;

  constructor(opts: NoShowDetectorOptions = {}) {
    this.maxGpsAccuracyM =
      opts.maxGpsAccuracyM ?? DEFAULT_MAX_GPS_ACCURACY_M;
    this.emitAudit = opts.emitAudit ?? this._defaultEmitAudit;
  }

  /**
   * Evaluate whether a booking intent constitutes a no‑show.
   *
   * Both `gpsCheckIn` and `supplierConfirmation` are optional. Pass `null`
   * or `undefined` for signals that have not been received.
   *
   * @param intentId           – Booking intent identifier
   * @param slotId             – Slot identifier for cross‑referencing
   * @param gpsCheckIn         – Buyer GPS check‑in (or null/undefined)
   * @param slotLocation       – Expected slot location (required if GPS provided)
   * @param supplierConfirmation – Supplier attendance confirmation (or null/undefined)
   */
  evaluate(
    intentId: string,
    slotId: string,
    gpsCheckIn: GpsCheckIn | null | undefined,
    slotLocation: SlotLocation | null | undefined,
    supplierConfirmation: SupplierConfirmation | null | undefined,
  ): NoShowEvaluationResult {
    const reasons: string[] = [];
    let gpsReceived = false;
    let gpsWithinRadius: boolean | null = null;
    let supplierReceived = false;
    let supplierConfirmed: boolean | null = null;
    let gpsCoordinateHash: string | null = null;

    // ── Evaluate GPS check‑in ──────────────────────────────────────────────
    if (gpsCheckIn && slotLocation) {
      gpsReceived = true;
      const within = isWithinRadius(
        gpsCheckIn.coordinates,
        slotLocation,
        gpsCheckIn.accuracyMeters,
        this.maxGpsAccuracyM,
      );

      if (within === null) {
        // Accuracy too poor — cannot trust this signal
        gpsWithinRadius = null;
        reasons.push("gps_accuracy_untrusted");
      } else {
        gpsWithinRadius = within;
        if (within) {
          reasons.push("gps_within_radius");
        } else {
          reasons.push("gps_outside_radius");
        }
      }

      gpsCoordinateHash = hashCoordinates(
        gpsCheckIn.coordinates.latitude,
        gpsCheckIn.coordinates.longitude,
        slotId,
      );
    } else if (gpsCheckIn && !slotLocation) {
      // GPS provided but no slot location to compare against
      gpsReceived = true;
      gpsWithinRadius = null; // Can't evaluate without slot location
      reasons.push("gps_no_slot_location");
    } else {
      // No GPS signal submitted
      reasons.push("gps_not_submitted");
    }

    // ── Evaluate supplier confirmation ─────────────────────────────────────
    if (supplierConfirmation) {
      supplierReceived = true;
      supplierConfirmed = supplierConfirmation.confirmed;
      if (supplierConfirmation.confirmed) {
        reasons.push("supplier_confirmed_present");
      } else {
        reasons.push("supplier_confirmed_absent");
      }
    } else {
      reasons.push("supplier_not_submitted");
    }

    // ── Combine signals ────────────────────────────────────────────────────
    //
    // isNoShow = true  only when BOTH signals are received AND both
    //                      explicitly indicate the buyer was absent.
    //
    // GPS indicates absence ONLY when it is explicitly outside the radius
    // (gpsWithinRadius === false). Untrusted/unusable GPS (null) does NOT
    // count as absence — it is treated as "can't tell" and falls through
    // to isInsufficient when the other signal is negative.
    //
    // We never penalise on a single negative signal alone.
    const gpsUnusable = gpsReceived && gpsWithinRadius === null;
    const gpsIndicatesAbsence =
      gpsReceived && gpsWithinRadius === false;
    const supplierIndicatesAbsence =
      supplierReceived && supplierConfirmed === false;

    const isNoShow = gpsIndicatesAbsence && supplierIndicatesAbsence;

    // Insufficient: one signal is missing or unusable while the other
    // indicates absence, or both are missing/unusable.
    const isInsufficient =
      !isNoShow &&
      ((!gpsReceived && supplierIndicatesAbsence) ||
        (gpsUnusable && supplierIndicatesAbsence) ||
        (gpsIndicatesAbsence && !supplierReceived) ||
        (!gpsReceived && !supplierReceived) ||
        (gpsUnusable && !supplierReceived));

    // Confidence: 1.0 when both signals agree, 0.5 when only one is present,
    // 0.0 when no signals.
    const signalCount =
      (gpsReceived ? 1 : 0) + (supplierReceived ? 1 : 0);
    const confidence =
      signalCount === 2
        ? 1.0
        : signalCount === 1
          ? 0.5
          : 0.0;

    const evaluatedAt = new Date().toISOString();

    const result: NoShowEvaluationResult = {
      isNoShow,
      isInsufficient,
      confidence,
      signals: {
        gps: { received: gpsReceived, value: gpsWithinRadius },
        supplier: { received: supplierReceived, value: supplierConfirmed },
      },
      reasons,
      evaluatedAt,
    };

    // ── Audit trail ────────────────────────────────────────────────────────
    try {
      this.emitAudit({
        intentId,
        slotId,
        isNoShow,
        hadGpsCheckIn: gpsReceived,
        hadSupplierConfirmation: supplierReceived,
        gpsWithinRadius,
        supplierConfirmed,
        gpsCoordinateHash,
        confidence,
        evaluatedAt,
      });
    } catch {
      // Audit emission failure must never block the evaluation result.
    }

    // ── Structured log ─────────────────────────────────────────────────────
    if (isNoShow) {
      logger.warn(
        {
          intentId,
          slotId,
          gpsWithinRadius,
          supplierConfirmed,
          confidence,
        },
        "No‑show detected: both GPS and supplier signals indicate absence",
      );
    }

    return result;
  }

  /* ─── Private helpers ─────────────────────────────────────────────────── */

  /**
   * Default audit emitter: writes a structured record via the application
   * audit logger.
   */
  private _defaultEmitAudit(record: NoShowAuditRecord): void {
    defaultAuditLogger
      .log("NO_SHOW_EVALUATION", {
        method: "NoShowDetector.evaluate",
        body: record as unknown as Record<string, unknown>,
        context: {
          intentId: record.intentId,
          slotId: record.slotId,
          isNoShow: record.isNoShow,
        },
      })
      .catch((err: unknown) => {
        logger.error({ err }, "Failed to write no‑show audit record");
      });
  }
}

/* ─── Singleton ───────────────────────────────────────────────────────────── */

let _instance: NoShowDetector | null = null;

/** Get or create the module‑level singleton. */
export function getNoShowDetector(opts?: NoShowDetectorOptions): NoShowDetector {
  if (!_instance) _instance = new NoShowDetector(opts);
  return _instance;
}

/** Reset the singleton (test isolation only). */
export function resetNoShowDetectorSingleton(): void {
  _instance = null;
}

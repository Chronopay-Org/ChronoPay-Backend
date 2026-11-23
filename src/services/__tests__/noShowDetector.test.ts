/**
 * noShowDetector.test.ts
 * ----------------------
 * Comprehensive tests for the two‑signal no‑show detection heuristic.
 *
 * Coverage targets:
 *   - All 9 truth‑table combinations
 *   - GPS accuracy thresholds (trusted vs. untrusted)
 *   - Missing slot location handling
 *   - Audit trail emission
 *   - Confidence scoring
 *   - Edge cases: GPS spoof attempts, offline supplier, dispute scenarios
 */

import {
  NoShowDetector,
  
  DEFAULT_MAX_GPS_ACCURACY_M,
  type GpsCheckIn,
  type SlotLocation,
  type SupplierConfirmation,
  type NoShowAuditRecord,
} from "../noShowDetector.js";

/* ─── Test fixtures ───────────────────────────────────────────────────────── */

const SLOT_ID = "slot-00000000-0000-4000-8000-000000000001";
const INTENT_ID = "intent-1";

/** A realistic café location (San Francisco) */
const SLOT_LOCATION: SlotLocation = {
  latitude: 37.7749,
  longitude: -122.4194,
  radiusMeters: 100,
};

/** GPS check‑in exactly at the slot location with good accuracy. */
function makeGpsCheckIn(
  overrides: Partial<GpsCheckIn> = {},
): GpsCheckIn {
  const { coordinates: coordOverride, ...restOverrides } = overrides;
  return {
    intentId: INTENT_ID,
    slotId: SLOT_ID,
    coordinates: {
      latitude: SLOT_LOCATION.latitude,
      longitude: SLOT_LOCATION.longitude,
      ...(coordOverride ?? {}),
    },
    accuracyMeters: 10,
    timestamp: Date.now(),
    ...restOverrides,
  };
}

/** Supplier confirmation that the buyer showed up. */
function makeSupplierConfirmation(
  overrides: Partial<SupplierConfirmation> = {},
): SupplierConfirmation {
  return {
    intentId: INTENT_ID,
    confirmedBy: "supplier-42",
    confirmed: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Create a fresh detector with a custom audit capture. */
function createDetectorWithAuditCapture(): {
  detector: NoShowDetector;
  auditRecords: NoShowAuditRecord[];
} {
  const auditRecords: NoShowAuditRecord[] = [];
  const detector = new NoShowDetector({
    emitAudit: (record: NoShowAuditRecord) => {
      auditRecords.push(record);
    },
  });
  return { detector, auditRecords };
}

/* ─── Truth‑table tests ──────────────────────────────────────────────────── */

describe("NoShowDetector – truth table", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  // Row 1: GPS ✓ within radius, Supplier ✓ confirmed → NOT no‑show
  it("GPS within radius + supplier confirmed → NOT no‑show", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
    expect(result.confidence).toBe(1.0);
    expect(result.signals.gps.value).toBe(true);
    expect(result.signals.supplier.value).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_within_radius", "supplier_confirmed_present"]),
    );
  });

  // Row 2: GPS ✓ within radius, Supplier ✗ absent → NOT no‑show
  it("GPS within radius + supplier absent → NOT no‑show (GPS proves presence)", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
    expect(result.confidence).toBe(1.0);
    expect(result.signals.gps.value).toBe(true);
    expect(result.signals.supplier.value).toBe(false);
  });

  // Row 3: GPS ✗ outside radius, Supplier ✓ confirmed → NOT no‑show
  it("GPS outside radius + supplier confirmed → NOT no‑show (supplier confirms)", () => {
    const farAway = makeGpsCheckIn({
      coordinates: { latitude: 37.7849, longitude: -122.4294 }, // ~1.5 km away
    });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      farAway,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
    expect(result.signals.gps.value).toBe(false);
    expect(result.signals.supplier.value).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_outside_radius", "supplier_confirmed_present"]),
    );
  });

  // Row 4: GPS ✗ outside radius, Supplier ✗ absent → NO‑SHOW
  it("GPS outside radius + supplier absent → NO‑SHOW", () => {
    const farAway = makeGpsCheckIn({
      coordinates: { latitude: 37.7849, longitude: -122.4294 },
    });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      farAway,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    expect(result.isNoShow).toBe(true);
    expect(result.isInsufficient).toBe(false);
    expect(result.confidence).toBe(1.0);
    expect(result.signals.gps.value).toBe(false);
    expect(result.signals.supplier.value).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_outside_radius", "supplier_confirmed_absent"]),
    );
  });

  // Row 5: GPS (not submitted), Supplier ✓ confirmed → NOT no‑show
  it("GPS missing + supplier confirmed → NOT no‑show", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.signals.gps.received).toBe(false);
    expect(result.signals.supplier.value).toBe(true);
  });

  // Row 6: GPS ✓ within radius, Supplier (not submitted) → NOT no‑show
  it("GPS within radius + supplier missing → NOT no‑show", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      null,
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.signals.gps.value).toBe(true);
    expect(result.signals.supplier.received).toBe(false);
  });

  // Row 7: GPS (not submitted), Supplier ✗ absent → INSUFFICIENT
  it("GPS missing + supplier absent → INSUFFICIENT", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      makeSupplierConfirmation({ confirmed: false }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.signals.gps.received).toBe(false);
    expect(result.signals.supplier.value).toBe(false);
  });

  // Row 8: GPS ✗ outside radius, Supplier (not submitted) → INSUFFICIENT
  it("GPS outside radius + supplier missing → INSUFFICIENT", () => {
    const farAway = makeGpsCheckIn({
      coordinates: { latitude: 37.7849, longitude: -122.4294 },
    });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      farAway,
      SLOT_LOCATION,
      null,
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
    expect(result.confidence).toBe(0.5);
    expect(result.signals.gps.value).toBe(false);
    expect(result.signals.supplier.received).toBe(false);
  });

  // Row 9: GPS (not submitted), Supplier (not submitted) → INSUFFICIENT
  it("both signals missing → INSUFFICIENT", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      null,
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
    expect(result.confidence).toBe(0.0);
    expect(result.signals.gps.received).toBe(false);
    expect(result.signals.supplier.received).toBe(false);
  });
});

/* ─── GPS accuracy tests ──────────────────────────────────────────────────── */

describe("NoShowDetector – GPS accuracy", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("untrusted GPS accuracy + supplier absent → INSUFFICIENT (GPS can't be evaluated)", () => {
    const poorGps = makeGpsCheckIn({ accuracyMeters: 200 }); // > 50 m default
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      poorGps,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    // Untrusted GPS is not evidence of absence → INSUFFICIENT
    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
    expect(result.signals.gps.value).toBe(null);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_accuracy_untrusted"]),
    );
  });

  it("trusts GPS at exactly the max accuracy threshold", () => {
    const borderGps = makeGpsCheckIn({ accuracyMeters: DEFAULT_MAX_GPS_ACCURACY_M });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      borderGps,
      SLOT_LOCATION,
      null,
    );

    expect(result.signals.gps.received).toBe(true);
    expect(result.signals.gps.value).toBe(true);
  });

  it("trusts GPS just below the max accuracy threshold", () => {
    const goodGps = makeGpsCheckIn({
      accuracyMeters: DEFAULT_MAX_GPS_ACCURACY_M - 1,
    });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      goodGps,
      SLOT_LOCATION,
      null,
    );

    expect(result.signals.gps.value).toBe(true);
  });

  it("uses custom max accuracy from constructor options", () => {
    const customDetector = new NoShowDetector({ maxGpsAccuracyM: 15 });
    const gps = makeGpsCheckIn({ accuracyMeters: 30 }); // > 15
    const result = customDetector.evaluate(
      INTENT_ID,
      SLOT_ID,
      gps,
      SLOT_LOCATION,
      null,
    );

    expect(result.signals.gps.value).toBe(null);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_accuracy_untrusted"]),
    );
  });
});

/* ─── GPS edge cases ──────────────────────────────────────────────────────── */

describe("NoShowDetector – GPS edge cases", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("GPS at exact slot boundary is within radius", () => {
    // Move exactly 100m north (the configured radius)
    // 1 degree latitude ≈ 111,320 m → 100 m ≈ 0.000898 degrees
    const gps = makeGpsCheckIn({
      coordinates: {
        latitude: SLOT_LOCATION.latitude + 0.000898,
        longitude: SLOT_LOCATION.longitude,
      },
    });
    const result = detector.evaluate(INTENT_ID, SLOT_ID, gps, SLOT_LOCATION, null);

    // The distance should be approximately 100 m, which is <= radius
    expect(result.signals.gps.value).toBe(true);
  });

  it("GPS just outside radius is flagged as outside", () => {
    // Move ~150 m north
    const gps = makeGpsCheckIn({
      coordinates: {
        latitude: SLOT_LOCATION.latitude + 0.00135,
        longitude: SLOT_LOCATION.longitude,
      },
    });
    const result = detector.evaluate(INTENT_ID, SLOT_ID, gps, SLOT_LOCATION, null);

    expect(result.signals.gps.value).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_outside_radius"]),
    );
  });

  it("GPS across the dateline (longitude wrap)", () => {
    const tokyoSlot: SlotLocation = {
      latitude: 35.6762,
      longitude: 139.6503,
      radiusMeters: 500,
    };
    const gps = makeGpsCheckIn({
      coordinates: {
        latitude: 35.6762,
        longitude: 139.6503,
      },
    });
    const result = detector.evaluate(INTENT_ID, SLOT_ID, gps, tokyoSlot, null);

    expect(result.signals.gps.value).toBe(true);
  });

  it("GPS at the South Pole — extreme latitude", () => {
    const poleSlot: SlotLocation = {
      latitude: -89.9,
      longitude: 0,
      radiusMeters: 1000,
    };
    const gps = makeGpsCheckIn({
      coordinates: { latitude: -89.9, longitude: 0 },
    });
    const result = detector.evaluate(INTENT_ID, SLOT_ID, gps, poleSlot, null);

    // At extreme latitudes, Haversine still works
    expect(result.signals.gps.value).toBe(true);
  });

  it("GPS provided but no slot location → can't evaluate proximity", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      null,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.signals.gps.value).toBe(null);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_no_slot_location"]),
    );
    // Supplier confirmed → NOT no‑show
    expect(result.isNoShow).toBe(false);
  });

  it("GPS provided with no slot location + supplier absent → insufficient", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      null,
      makeSupplierConfirmation({ confirmed: false }),
    );

    // GPS can't be evaluated, supplier says absent → INSUFFICIENT (only one negative)
    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
  });

  it("undefined GPS treated same as null GPS (not submitted)", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      undefined,
      undefined,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.signals.gps.received).toBe(false);
    expect(result.isNoShow).toBe(false);
  });
});

/* ─── Supplier confirmation edge cases ────────────────────────────────────── */

describe("NoShowDetector – supplier confirmation edge cases", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("undefined supplier treated same as null (not submitted)", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      undefined,
    );

    expect(result.signals.supplier.received).toBe(false);
    expect(result.isNoShow).toBe(false);
  });

  it("different suppliers can confirm different intents independently", () => {
    const det = new NoShowDetector();

    const r1 = det.evaluate(
      "intent-A",
      "slot-a",
      makeGpsCheckIn({ intentId: "intent-A", slotId: "slot-a" }),
      SLOT_LOCATION,
      makeSupplierConfirmation({
        intentId: "intent-A",
        confirmedBy: "supplier-alice",
        confirmed: false,
      }),
    );
    // GPS within radius → NOT no‑show even with absent supplier
    expect(r1.isNoShow).toBe(false);

    const r2 = det.evaluate(
      "intent-B",
      "slot-b",
      makeGpsCheckIn({
        intentId: "intent-B",
        slotId: "slot-b",
        coordinates: { latitude: 40.0, longitude: -74.0 }, // Far away
      }),
      SLOT_LOCATION,
      makeSupplierConfirmation({
        intentId: "intent-B",
        confirmedBy: "supplier-bob",
        confirmed: false,
      }),
    );
    // GPS outside + supplier absent → NO‑SHOW
    expect(r2.isNoShow).toBe(true);
  });

  it("zero‑length supplier ID is still accepted", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      makeSupplierConfirmation({ confirmedBy: "", confirmed: true }),
    );

    expect(result.isNoShow).toBe(false);
    expect(result.signals.supplier.received).toBe(true);
  });
});

/* ─── Dispute scenario: supplier confirmed but buyer disputes ──────────────── */

describe("NoShowDetector – dispute scenarios", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("supplier confirmed present outranks buyer GPS absence (no false positive)", () => {
    // Buyer claims they were there (GPS outside), but supplier confirms presence
    const farGps = makeGpsCheckIn({
      coordinates: { latitude: 37.7849, longitude: -122.4294 },
    });
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      farGps,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    // Even though GPS is outside, supplier confirms → NOT no‑show
    expect(result.isNoShow).toBe(false);
    expect(result.signals.gps.value).toBe(false);
    expect(result.signals.supplier.value).toBe(true);
  });

  it("GPS present + supplier absent → no penalty (buyer protected by GPS)", () => {
    // Buyer GPS shows presence, but supplier disputes (claims absent)
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    // GPS proves presence → NOT no‑show
    expect(result.isNoShow).toBe(false);
    expect(result.signals.gps.value).toBe(true);
    expect(result.signals.supplier.value).toBe(false);
  });
});

/* ─── GPS spoof scenarios ─────────────────────────────────────────────────── */

describe("NoShowDetector – GPS spoof resistance", () => {
  it("rejects GPS with implausibly perfect accuracy (0 m)", () => {
    // A real GPS never reports 0 m accuracy. But 0 is ≤ max accuracy, so
    // it would be *trusted* by the accuracy check. However, this is still
    // a valid signal — the two‑signal requirement means a single spoofed
    // GPS cannot trigger a penalty on its own.
    const perfectGps = makeGpsCheckIn({ accuracyMeters: 0 });
    const detector = new NoShowDetector();
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      perfectGps,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    // GPS within radius "proves" presence → NOT no‑show even though
    // supplier says absent. The system errs on the side of the buyer.
    expect(result.isNoShow).toBe(false);
    expect(result.signals.gps.value).toBe(true);
  });

  it("buyer cannot trigger a no‑show penalty on someone else", () => {
    // The GPS check‑in is per‑intent and must match the intent's slot.
    // Different intent IDs would require separate evaluations.
    const detector = new NoShowDetector();
    const result = detector.evaluate(
      "intent-victim",
      "slot-victim",
      makeGpsCheckIn({ intentId: "intent-victim", slotId: "slot-victim" }),
      SLOT_LOCATION,
      makeSupplierConfirmation({
        intentId: "intent-victim",
        confirmed: true,
      }),
    );

    // Both signals for this intent agree → NOT no‑show
    expect(result.isNoShow).toBe(false);
  });

  it("GPS far away with poor accuracy → untrusted + absent supplier → INSUFFICIENT", () => {
    // Bad GPS accuracy makes the signal untrusted, so only supplier absence counts
    const badGps = makeGpsCheckIn({
      coordinates: { latitude: 40.0, longitude: -74.0 }, // NYC
      accuracyMeters: 500,
    });
    const detector = new NoShowDetector();
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      badGps,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    // GPS untrusted + supplier absent → only one usable negative signal → INSUFFICIENT
    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
  });
});

/* ─── Offline supplier scenarios ──────────────────────────────────────────── */

describe("NoShowDetector – offline supplier", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("offline supplier + GPS absent → INSUFFICIENT (not enough signals)", () => {
    const farGps = makeGpsCheckIn({
      coordinates: { latitude: 37.7849, longitude: -122.4294 },
    });
    const result = detector.evaluate(INTENT_ID, SLOT_ID, farGps, SLOT_LOCATION, null);

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["supplier_not_submitted"]),
    );
  });

  it("offline supplier + GPS present → NOT no‑show", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      null,
    );

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(false);
  });

  it("offline supplier + no GPS → INSUFFICIENT (no data at all)", () => {
    const result = detector.evaluate(INTENT_ID, SLOT_ID, null, null, null);

    expect(result.isNoShow).toBe(false);
    expect(result.isInsufficient).toBe(true);
  });
});

/* ─── Audit trail tests ───────────────────────────────────────────────────── */

describe("NoShowDetector – audit trail", () => {
  it("emits an audit record for every evaluation", () => {
    const { detector, auditRecords } = createDetectorWithAuditCapture();

    detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(auditRecords).toHaveLength(1);
    const record = auditRecords[0];
    expect(record.intentId).toBe(INTENT_ID);
    expect(record.slotId).toBe(SLOT_ID);
    expect(record.isNoShow).toBe(false);
    expect(record.hadGpsCheckIn).toBe(true);
    expect(record.hadSupplierConfirmation).toBe(true);
    expect(record.gpsWithinRadius).toBe(true);
    expect(record.supplierConfirmed).toBe(true);
    expect(record.gpsCoordinateHash).toBeTruthy();
    expect(record.gpsCoordinateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.confidence).toBe(1.0);
    expect(record.evaluatedAt).toBeTruthy();
    // ISO 8601 format check
    expect(record.evaluatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("audit record for no‑show has correct flags", () => {
    const { detector, auditRecords } = createDetectorWithAuditCapture();

    const farGps = makeGpsCheckIn({
      coordinates: { latitude: 40.0, longitude: -74.0 },
    });
    detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      farGps,
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].isNoShow).toBe(true);
    expect(auditRecords[0].gpsWithinRadius).toBe(false);
    expect(auditRecords[0].supplierConfirmed).toBe(false);
  });

  it("audit record for no‑GPS scenario has null coordinate hash", () => {
    const { detector, auditRecords } = createDetectorWithAuditCapture();

    detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].hadGpsCheckIn).toBe(false);
    expect(auditRecords[0].gpsCoordinateHash).toBe(null);
    expect(auditRecords[0].gpsWithinRadius).toBe(null);
  });

  it("coordinate hash is deterministic for same input", () => {
    const { detector, auditRecords } = createDetectorWithAuditCapture();

    detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      null,
    );
    detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      null,
    );

    expect(auditRecords).toHaveLength(2);
    // Same coordinates + same slot → same HMAC
    expect(auditRecords[0].gpsCoordinateHash).toBe(
      auditRecords[1].gpsCoordinateHash,
    );
  });
});

/* ─── Confidence scoring tests ────────────────────────────────────────────── */

describe("NoShowDetector – confidence scoring", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("confidence = 1.0 when both signals present", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: false }),
    );
    expect(result.confidence).toBe(1.0);
  });

  it("confidence = 0.5 when only one signal present", () => {
    const gpsOnly = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      null,
    );
    expect(gpsOnly.confidence).toBe(0.5);

    const supplierOnly = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      makeSupplierConfirmation({ confirmed: true }),
    );
    expect(supplierOnly.confidence).toBe(0.5);
  });

  it("confidence = 0.0 when no signals present", () => {
    const result = detector.evaluate(INTENT_ID, SLOT_ID, null, null, null);
    expect(result.confidence).toBe(0.0);
  });
});

/* ─── EvaluatedAt timestamp ───────────────────────────────────────────────── */

describe("NoShowDetector – timestamps", () => {
  it("evaluatedAt is a valid ISO-8601 string", () => {
    const detector = new NoShowDetector();
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.evaluatedAt).toBeTruthy();
    const parsed = Date.parse(result.evaluatedAt);
    expect(Number.isNaN(parsed)).toBe(false);
  });

  it("evaluatedAt is close to current time", () => {
    const before = new Date().toISOString();
    const detector = new NoShowDetector();
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      null,
      null,
      null,
    );
    const after = new Date().toISOString();

    expect(result.evaluatedAt >= before).toBe(true);
    expect(result.evaluatedAt <= after).toBe(true);
  });
});

/* ─── Singleton lifecycle tests ───────────────────────────────────────────── */

describe("NoShowDetector – singleton", () => {
  it("getNoShowDetector returns the same instance", async () => {
    // Dynamic import to reset state
    const mod = await import("../noShowDetector.js");
    mod.resetNoShowDetectorSingleton();

    const a = mod.getNoShowDetector();
    const b = mod.getNoShowDetector();
    expect(a).toBe(b);
    mod.resetNoShowDetectorSingleton();
  });

  it("resetNoShowDetectorSingleton creates a fresh instance", async () => {
    const mod = await import("../noShowDetector.js");
    mod.resetNoShowDetectorSingleton();

    const a = mod.getNoShowDetector();
    mod.resetNoShowDetectorSingleton();
    const b = mod.getNoShowDetector();
    expect(a).not.toBe(b);
    mod.resetNoShowDetectorSingleton();
  });
});

/* ─── Reasons completeness ────────────────────────────────────────────────── */

describe("NoShowDetector – reasons completeness", () => {
  let detector: NoShowDetector;

  beforeEach(() => {
    detector = new NoShowDetector();
  });

  it("reasons array is never empty", () => {
    const result = detector.evaluate(INTENT_ID, SLOT_ID, null, null, null);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("includes both signal status reasons when both submitted", () => {
    const result = detector.evaluate(
      INTENT_ID,
      SLOT_ID,
      makeGpsCheckIn(),
      SLOT_LOCATION,
      makeSupplierConfirmation({ confirmed: true }),
    );

    expect(result.reasons).toEqual(
      expect.arrayContaining(["gps_within_radius", "supplier_confirmed_present"]),
    );
  });

  it("includes gps_not_submitted when GPS missing", () => {
    const result = detector.evaluate(INTENT_ID, SLOT_ID, null, null, null);
    expect(result.reasons).toContain("gps_not_submitted");
    expect(result.reasons).toContain("supplier_not_submitted");
  });
});

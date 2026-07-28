import {
  CancellationPolicyService,
  computeRefundWithTerms,
  selectTierForCancellation,
  validateProratedCancellationTerms,
  LEGACY_V1_VERSION,
  PRORATED_V2_VERSION,
  PRORATED_V2_TERMS,
  createDefaultRegistry,
  VersionedPolicyRegistry,
} from "../cancellationPolicy.js";
import {
  BookingIntentRecord,
  CancellationPolicySnapshot,
  ProratedCancellationTerms,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { AuditLogger } from "../auditLogger.js";

const BASE_PRICE = 10000;
const HOUR_MS = 1000 * 60 * 60;

function makeAuditLogger() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditLogger;
}

function makeIntent(overrides: Partial<BookingIntentRecord> = {}): BookingIntentRecord {
  return {
    id: "intent-1",
    slotId: "slot-1",
    professional: "prof-1",
    customerId: "cust-1",
    startTime: Date.now() + 48 * HOUR_MS,
    endTime: Date.now() + 49 * HOUR_MS,
    status: "pending",
    createdAt: new Date().toISOString(),
    pricingSnapshot: {
      strategyId: "fixed",
      resolvedPrice: BASE_PRICE,
      basePrice: BASE_PRICE,
      slotStartMs: Date.now() + 48 * HOUR_MS,
      nowMs: Date.now(),
      activeBookings: 0,
      capacity: 1,
      config: { strategy: "fixed" },
    },
    ...overrides,
  };
}

describe("validateProratedCancellationTerms", () => {
  it("accepts valid v2 terms", () => {
    expect(() => validateProratedCancellationTerms(PRORATED_V2_TERMS)).not.toThrow();
  });

  it("rejects empty tiers", () => {
    expect(() => validateProratedCancellationTerms({ tiers: [] })).toThrow();
  });

  it("rejects overlapping tiers", () => {
    const bad: ProratedCancellationTerms = {
      tiers: [
        { minHoursUntilStart: 24, refundRatio: 1 },
        { minHoursUntilStart: 12, maxHoursUntilStart: 36, refundRatio: 0.5 },
      ],
    };
    expect(() => validateProratedCancellationTerms(bad)).toThrow(/overlaps/);
  });

  it("rejects refundRatio outside [0,1]", () => {
    expect(() =>
      validateProratedCancellationTerms({
        tiers: [{ minHoursUntilStart: 0, refundRatio: 1.5 }],
      }),
    ).toThrow();
  });

  it("rejects negative flatFee", () => {
    expect(() =>
      validateProratedCancellationTerms({
        tiers: [{ minHoursUntilStart: 0, refundRatio: 0, flatFee: -1 }],
      }),
    ).toThrow();
  });

  it("rejects inverted min/max refund bounds", () => {
    expect(() =>
      validateProratedCancellationTerms({
        tiers: [{ minHoursUntilStart: 0, refundRatio: 1 }],
        minRefundAmount: 100,
        maxRefundAmount: 50,
      }),
    ).toThrow();
  });
});

describe("selectTierForCancellation", () => {
  const terms = PRORATED_V2_TERMS;

  it("selects ≥168h (100%) tier for 200h", () => {
    const tier = selectTierForCancellation(terms, 200);
    expect(tier?.minHoursUntilStart).toBe(168);
    expect(tier?.refundRatio).toBe(1.0);
  });

  it("selects 72–168h (85%) tier for 100h", () => {
    const tier = selectTierForCancellation(terms, 100);
    expect(tier?.refundRatio).toBe(0.85);
  });

  it("selects 24–72h (60%) tier for 48h", () => {
    const tier = selectTierForCancellation(terms, 48);
    expect(tier?.refundRatio).toBe(0.6);
    expect(tier?.flatFee).toBe(50);
  });

  it("selects 12–24h (30%) tier for 18h", () => {
    const tier = selectTierForCancellation(terms, 18);
    expect(tier?.refundRatio).toBe(0.3);
    expect(tier?.flatFee).toBe(100);
  });

  it("selects 0–12h (0%) tier for 6h", () => {
    const tier = selectTierForCancellation(terms, 6);
    expect(tier?.refundRatio).toBe(0);
  });

  it("boundary: exactly 168h falls into ≥168h tier", () => {
    const tier = selectTierForCancellation(terms, 168);
    expect(tier?.minHoursUntilStart).toBe(168);
  });

  it("boundary: exactly 72h falls into 72–168 tier", () => {
    const tier = selectTierForCancellation(terms, 72);
    expect(tier?.refundRatio).toBe(0.85);
  });
});

describe("computeRefundWithTerms (v2-prorated arithmetic)", () => {
  const V = PRORATED_V2_VERSION.versionId;

  it("200h before: full refund, no flat fee", () => {
    const r = computeRefundWithTerms(PRORATED_V2_TERMS, BASE_PRICE, 200, V);
    expect(r.tierApplied?.refundRatio).toBe(1);
    expect(r.basePrice).toBe(BASE_PRICE);
    const baseRefund = BASE_PRICE;
    const expectedTax = Math.round(baseRefund * 0.1);
    const expectedFee = Math.round(baseRefund * 0) + 0;
    expect(r.taxReversal).toBe(expectedTax);
    expect(r.fee).toBe(expectedFee);
    expect(r.netRefund).toBe(baseRefund + expectedTax - expectedFee);
    expect(r.policyVersion).toBe(V);
  });

  it("48h before: 60% refund + 50 flat fee", () => {
    const r = computeRefundWithTerms(PRORATED_V2_TERMS, BASE_PRICE, 48, V);
    expect(r.tierApplied?.refundRatio).toBe(0.6);
    expect(r.tierApplied?.flatFee).toBe(50);
    const baseRefund = Math.round(BASE_PRICE * 0.6);
    const expectedTax = Math.round(baseRefund * 0.1);
    expect(r.taxReversal).toBe(expectedTax);
    expect(r.fee).toBe(50);
    expect(r.netRefund).toBe(baseRefund + expectedTax - 50);
  });

  it("18h before: 30% refund + 100 flat fee", () => {
    const r = computeRefundWithTerms(PRORATED_V2_TERMS, BASE_PRICE, 18, V);
    expect(r.tierApplied?.refundRatio).toBe(0.3);
    const baseRefund = Math.round(BASE_PRICE * 0.3);
    const expectedTax = Math.round(baseRefund * 0.1);
    expect(r.netRefund).toBe(baseRefund + expectedTax - 100);
  });

  it("6h before: 0 refund, 0 net", () => {
    const r = computeRefundWithTerms(PRORATED_V2_TERMS, BASE_PRICE, 6, V);
    expect(r.tierApplied?.refundRatio).toBe(0);
    expect(r.netRefund).toBe(0);
  });

  it("never returns negative netRefund even with big flat fee on tiny price", () => {
    const tinyTerms: ProratedCancellationTerms = {
      tiers: [
        {
          minHoursUntilStart: 0,
          refundRatio: 0.1,
          flatFee: 1000,
        },
      ],
    };
    const r = computeRefundWithTerms(tinyTerms, 100, 10, V);
    expect(r.netRefund).toBeGreaterThanOrEqual(0);
  });

  it("respects maxRefundAmount cap", () => {
    const terms: ProratedCancellationTerms = {
      tiers: [{ minHoursUntilStart: 0, refundRatio: 1 }],
      maxRefundAmount: 500,
    };
    const r = computeRefundWithTerms(terms, 10000, 100, V);
    expect(r.netRefund).toBeLessThanOrEqual(500);
  });

  it("respects minRefundAmount floor", () => {
    const terms: ProratedCancellationTerms = {
      tiers: [{ minHoursUntilStart: 0, refundRatio: 0 }],
      minRefundAmount: 42,
    };
    const r = computeRefundWithTerms(terms, 10000, 1, V);
    expect(r.netRefund).toBeGreaterThanOrEqual(42);
  });
});

describe("CancellationPolicyService grandfathering", () => {
  function makeService(
    nowMs: () => number,
    registryOverride?: VersionedPolicyRegistry,
  ) {
    const registry = registryOverride ?? createDefaultRegistry();
    return new CancellationPolicyService({
      getPolicyRegistrySync: () => registry,
      auditLogger: makeAuditLogger(),
      nowMs,
      nowIso: () => new Date(nowMs()).toISOString(),
    });
  }

  it("uses grandfathered v1 policy on bookings that stored v1 snapshot — even after v2 becomes current", () => {
    const nowMs = () => Date.now();
    const service = makeService(nowMs);

    const v1Snapshot: CancellationPolicySnapshot = {
      policyVersionId: LEGACY_V1_VERSION.versionId,
      policyTerms: {
        tiers: [
          {
            minHoursUntilStart: 24,
            refundRatio: 1,
            percentageFee: 0.05,
            taxReversalRatio: 0.1,
          },
          {
            minHoursUntilStart: 12,
            maxHoursUntilStart: 24,
            refundRatio: 0.5,
            percentageFee: 0.05,
            taxReversalRatio: 0.1,
          },
          {
            minHoursUntilStart: 0,
            maxHoursUntilStart: 12,
            refundRatio: 0,
            percentageFee: 0.05,
            taxReversalRatio: 0.1,
          },
        ],
        minRefundAmount: 0,
      },
      capturedAtMs: Date.now() - 1000,
    };

    const startTime = Date.now() + 48 * HOUR_MS;
    const oldBooking = makeIntent({
      startTime,
      cancellationPolicySnapshot: v1Snapshot,
    });
    const refund = service.calculateRefund(oldBooking);
    expect(refund.policyVersion).toBe(LEGACY_V1_VERSION.versionId);
    expect(refund.tierApplied?.refundRatio).toBe(1);
    const expectedV1Fee = Math.round(BASE_PRICE * 1 * 0.05);
    expect(refund.fee).toBe(expectedV1Fee);
  });

  it("uses current v2 policy on new bookings with v2 snapshot", () => {
    const nowMs = () => Date.now();
    const service = makeService(nowMs);
    const startTime = Date.now() + 48 * HOUR_MS;
    const v2Snapshot = service.snapshotCurrentPolicy();
    expect(v2Snapshot.policyVersionId).toBe(PRORATED_V2_VERSION.versionId);

    const newBooking = makeIntent({
      startTime,
      cancellationPolicySnapshot: v2Snapshot,
    });
    const refund = service.calculateRefund(newBooking);
    expect(refund.policyVersion).toBe(PRORATED_V2_VERSION.versionId);
    expect(refund.tierApplied?.refundRatio).toBe(0.6);
    expect(refund.fee).toBe(50);
  });

  it("falls back to legacy v1 when booking has no snapshot (pre-versioning bookings)", () => {
    const nowMs = () => Date.now();
    const service = makeService(nowMs);
    const startTime = Date.now() + 48 * HOUR_MS;
    const ancientBooking = makeIntent({
      startTime,
      cancellationPolicySnapshot: undefined,
    });
    const refund = service.calculateRefund(ancientBooking);
    expect(refund.policyVersion).toBe(LEGACY_V1_VERSION.versionId);
  });

  it("throws 409 when booking is already cancelled", () => {
    const service = makeService(() => Date.now());
    const cancelled = makeIntent({ status: "cancelled" });
    expect(() => service.calculateRefund(cancelled)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
});

describe("snapshotPolicyAtTime", () => {
  it("picks v1 for a date in 2025, v2 for a date in 2026", () => {
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: createDefaultRegistry,
      auditLogger: makeAuditLogger(),
    });

    const jan2025 = new Date("2025-06-01T00:00:00Z").getTime();
    const snap1 = service.snapshotPolicyAtTime(jan2025);
    expect(snap1.policyVersionId).toBe(LEGACY_V1_VERSION.versionId);

    const mar2026 = new Date("2026-03-15T12:00:00Z").getTime();
    const snap2 = service.snapshotPolicyAtTime(mar2026);
    expect(snap2.policyVersionId).toBe(PRORATED_V2_VERSION.versionId);
  });
});

describe("registerNewPolicyVersion", () => {
  it("creates v3, makes it current, and supersedes v2 with effectiveUntil", async () => {
    const logger = makeAuditLogger();
    const registry = createDefaultRegistry();
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: () => registry,
      auditLogger: logger,
    });

    const v3Terms: ProratedCancellationTerms = {
      tiers: [{ minHoursUntilStart: 0, refundRatio: 1 }],
    };
    const { registry: updated } = await service.registerNewPolicyVersion({
      versionId: "v3-generous",
      description: "100% refund always",
      terms: v3Terms,
      makeCurrent: true,
      changedBy: "admin-1",
      existingRegistry: registry,
    });

    expect(updated.currentVersionId).toBe("v3-generous");
    expect(updated.entries["v2-prorated"].version.effectiveUntil).toBeDefined();
    expect(updated.entries["v3-generous"]).toBeTruthy();
    expect(logger.log).toHaveBeenCalledWith(
      "cancellation_policy.version_registered",
      expect.anything(),
      expect.anything(),
    );
  });

  it("refuses to register a duplicate versionId", async () => {
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: createDefaultRegistry,
      auditLogger: makeAuditLogger(),
    });
    await expect(
      service.registerNewPolicyVersion({
        versionId: PRORATED_V2_VERSION.versionId,
        description: "duplicate",
        terms: PRORATED_V2_TERMS,
        changedBy: "admin-1",
        existingRegistry: createDefaultRegistry(),
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("listPolicyVersions and getCurrentVersion", () => {
  it("returns entries ordered by effectiveFrom desc", () => {
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: createDefaultRegistry,
      auditLogger: makeAuditLogger(),
    });
    const versions = service.listPolicyVersions();
    expect(versions[0].version.versionId).toBe(PRORATED_V2_VERSION.versionId);
    expect(versions[1].version.versionId).toBe(LEGACY_V1_VERSION.versionId);
  });

  it("getCurrentVersion returns v2", () => {
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: createDefaultRegistry,
      auditLogger: makeAuditLogger(),
    });
    expect(service.getCurrentVersion().version.versionId).toBe(PRORATED_V2_VERSION.versionId);
  });
});

describe("previewRefundWithOverride", () => {
  it("computes a refund using ad-hoc terms without mutating the booking", async () => {
    const service = new CancellationPolicyService({
      getPolicyRegistrySync: createDefaultRegistry,
      auditLogger: makeAuditLogger(),
      nowMs: () => Date.now(),
    });
    const booking = makeIntent({ startTime: Date.now() + 2 * HOUR_MS });
    const override: ProratedCancellationTerms = {
      tiers: [{ minHoursUntilStart: 0, refundRatio: 0.5 }],
    };
    const preview = await service.previewRefundWithOverride(booking, override);
    expect(preview.netRefund).toBe(Math.round(BASE_PRICE * 0.5));
    expect(preview.policyVersion).toContain("override-preview");
  });
});

import {
  AnomalyScorer,
  anomalyReviewQueue,
  assessBookingIntentAnomaly,
  computeVelocitySignal,
  computeBuyerAgeSignal,
  computeGeoHopSignal,
  pseudoLocationResolver,
  DEFAULT_FLAG_THRESHOLD,
} from "../anomalyScoring.js";

const FIXED_NOW = Date.parse("2026-08-24T12:00:00.000Z");
const daysAgo = (n: number) => FIXED_NOW - n * 24 * 60 * 60 * 1000;

describe("computeVelocitySignal", () => {
  it.each([undefined, 0, 1])("yields 0 for missing/low counts (%s)", (count) => {
    expect(computeVelocitySignal(count as number | undefined, 4)).toBe(0);
  });

  it.each([
    [2, 0.25],
    [3, 0.5],
    [4, 0.75],
    [5, 1],
    [50, 1],
  ])("scales linearly: count=%i -> %f", (count, expected) => {
    expect(computeVelocitySignal(count, 4)).toBe(expected);
  });

  it("treats negative and non-finite counts as missing", () => {
    expect(computeVelocitySignal(-5, 4)).toBe(0);
    expect(computeVelocitySignal(Number.NaN, 4)).toBe(0);
  });
});

describe("computeBuyerAgeSignal", () => {
  it("yields 0 when no age evidence is provided", () => {
    expect(computeBuyerAgeSignal({}, FIXED_NOW).signal).toBe(0);
  });

  it("yields max risk under 1 day (issue edge case)", () => {
    const result = computeBuyerAgeSignal({ customerSinceMs: daysAgo(0.5) }, FIXED_NOW);
    expect(result.signal).toBe(1);
    expect(result.reason).toBe("account_age_lt_1d");
  });

  it.each([
    [3, 0.5],
    [20, 0.2],
    [40, 0],
  ])("decays with age: %i day(s) -> %f", (ageDays, expected) => {
    expect(computeBuyerAgeSignal({ customerSinceMs: daysAgo(ageDays) }, FIXED_NOW).signal).toBe(
      expected,
    );
  });

  it("accepts ISO strings via firstIntentAt and prefers customerSinceMs", () => {
    expect(
      computeBuyerAgeSignal({ firstIntentAt: new Date(daysAgo(0.5)).toISOString() }, FIXED_NOW)
        .signal,
    ).toBe(1);
    expect(
      computeBuyerAgeSignal(
        { firstIntentAt: daysAgo(40), customerSinceMs: daysAgo(0.1) },
        FIXED_NOW,
      ).signal,
    ).toBe(1);
  });

  it("accepts epoch-millisecond firstIntentAt", () => {
    expect(computeBuyerAgeSignal({ firstIntentAt: daysAgo(3) }, FIXED_NOW).signal).toBe(0.5);
  });

  it("ignores future timestamps", () => {
    expect(computeBuyerAgeSignal({ customerSinceMs: FIXED_NOW + 1000 }, FIXED_NOW).signal).toBe(0);
  });
});

describe("computeGeoHopSignal", () => {
  it.each([
    [0, 0],
    [49.9, 0],
    [50, 0.3],
    [499, 0.3],
    [500, 0.7],
    [2999, 0.7],
    [3000, 1],
    [20015, 1],
  ])("bands distance %skm -> %f", (km, expected) => {
    expect(computeGeoHopSignal(km)).toBe(expected);
  });
});

describe("pseudoLocationResolver", () => {
  it("is deterministic for identical inputs", () => {
    expect(pseudoLocationResolver("203.0.113.9")).toEqual(pseudoLocationResolver("203.0.113.9"));
  });

  it("maps distinct IPs to distinct coordinates", () => {
    expect(pseudoLocationResolver("203.0.113.9")).not.toEqual(
      pseudoLocationResolver("198.51.100.7"),
    );
  });

  it("returns undefined for empty input", () => {
    expect(pseudoLocationResolver("")).toBeUndefined();
    expect(pseudoLocationResolver("   ")).toBeUndefined();
  });
});

describe("AnomalyScorer.evaluate", () => {
  const farLocations: Record<string, { lat: number; lng: number }> = {
    home: { lat: 0, lng: 0 },
    antipode: { lat: 0, lng: 180 },
  };
  const farResolver = (ip: string) => farLocations[ip];

  function makeScorer(overrides: ConstructorParameters<typeof AnomalyScorer>[0] = {}) {
    return new AnomalyScorer({
      resolveLocation: farResolver,
      nowMs: () => FIXED_NOW,
      ...overrides,
    });
  }

  it("scores 0 when all signals are missing (issue edge case)", () => {
    const assessment = makeScorer().evaluate({ customerId: "cust-1" });
    expect(assessment.score).toBe(0);
    expect(assessment.flagged).toBe(false);
    expect(assessment.signals).toEqual({
      velocity: 0,
      fingerprintRisk: 0,
      geoHopDistance: 0,
      buyerAge: 0,
    });
    expect(assessment.reasons).toEqual([]);
  });

  it("combines signals using the documented default weights", () => {
    const scorer = makeScorer();
    // velocity: count=5 -> 1 ; fingerprint: unseen -> 0.25 ; age <1d -> 1
    const first = scorer.evaluate({
      customerId: "cust-1",
      recentIntentCount: 5,
      deviceFingerprint: "fp-a",
      firstIntentAt: daysAgo(0.2),
      ipAddress: "home",
    });
    expect(first.signals).toMatchObject({ velocity: 1, fingerprintRisk: 0.25, buyerAge: 1 });
    expect(first.score).toBeCloseTo(1 * 0.35 + 0.25 * 0.2 + 0 * 0.3 + 1 * 0.15, 10);

    // Second request from the antipode saturates geo; the now-known
    // fingerprint is benign for the same customer.
    const second = scorer.evaluate({
      customerId: "cust-1",
      recentIntentCount: 5,
      deviceFingerprint: "fp-a",
      firstIntentAt: daysAgo(0.2),
      ipAddress: "antipode",
    });
    expect(second.score).toBeCloseTo(1 * 0.35 + 0 * 0.2 + 1 * 0.3 + 1 * 0.15, 10);
    expect(second.flagged).toBe(true);
  });

  it("flags strictly above the threshold (score == threshold is not flagged)", () => {
    // velocity-only score is exactly 1 * 0.35 = 0.35.
    const scorer = makeScorer({ flagThreshold: 0.35 });
    const assessment = scorer.evaluate({ customerId: "c", recentIntentCount: 5 });
    expect(assessment.score).toBeCloseTo(0.35, 10);
    expect(assessment.flagged).toBe(false);

    const strictScorer = makeScorer({ flagThreshold: 0.3499999 });
    expect(strictScorer.evaluate({ customerId: "c", recentIntentCount: 5 }).flagged).toBe(true);
  });

  it("honours a shared fingerprint across customers as a strong signal", () => {
    const scorer = makeScorer();
    expect(
      scorer.evaluate({ customerId: "a", deviceFingerprint: "fp" }).signals.fingerprintRisk,
    ).toBe(0.25);
    expect(
      scorer.evaluate({ customerId: "b", deviceFingerprint: "fp" }).signals.fingerprintRisk,
    ).toBe(1);
    expect(
      scorer.evaluate({ customerId: "a", deviceFingerprint: "fp" }).signals.fingerprintRisk,
    ).toBe(1);
  });

  it("treats a known single-customer fingerprint as benign on repeat use", () => {
    const scorer = makeScorer();
    scorer.evaluate({ customerId: "a", deviceFingerprint: "fp" });
    expect(
      scorer.evaluate({ customerId: "a", deviceFingerprint: "fp" }).signals.fingerprintRisk,
    ).toBe(0);
  });

  it("ignores blank fingerprints and IPs", () => {
    const scorer = makeScorer();
    expect(
      scorer.evaluate({ customerId: "c", deviceFingerprint: "   " }).signals.fingerprintRisk,
    ).toBe(0);
    expect(scorer.evaluate({ customerId: "c", ipAddress: "   " }).signals.geoHopDistance).toBe(0);
  });

  it("degrades to 0 when the resolver cannot locate an IP", () => {
    const scorer = makeScorer({ resolveLocation: () => undefined });
    expect(scorer.evaluate({ customerId: "c", ipAddress: "1.2.3.4" }).signals.geoHopDistance).toBe(
      0,
    );
  });

  it("flags extreme geo hops between consecutive requests (issue edge case)", () => {
    const scorer = makeScorer();
    const base = { customerId: "c", recentIntentCount: 1, firstIntentAt: daysAgo(365) };
    scorer.evaluate({ ...base, ipAddress: "home" });
    const hop = scorer.evaluate({ ...base, ipAddress: "antipode" });
    expect(hop.signals.geoHopDistance).toBe(1);
    expect(hop.reasons).toContainEqual(expect.stringMatching(/^geo_hop:\d+km$/));
  });

  it("does not emit a phantom hop when the same IP repeats or lookup fails mid-sequence", () => {
    const flakyTable: Record<string, { lat: number; lng: number } | undefined> = {
      a: { lat: 10, lng: 10 },
      b: undefined,
    };
    const scorer = makeScorer({ resolveLocation: (ip) => flakyTable[ip] });
    scorer.evaluate({ customerId: "c", ipAddress: "a" });
    expect(scorer.evaluate({ customerId: "c", ipAddress: "b" }).signals.geoHopDistance).toBe(0);
    expect(scorer.evaluate({ customerId: "c", ipAddress: "a" }).signals.geoHopDistance).toBe(0);
  });

  it("supports custom weights and clamps to [0, 1]", () => {
    const scorer = makeScorer({
      weights: { velocity: 2, fingerprintRisk: 2, geoHopDistance: 2, buyerAge: 2 },
    });
    const assessment = scorer.evaluate({ customerId: "c", recentIntentCount: 5 });
    expect(assessment.score).toBe(1);
  });

  it("reads configuration from env vars when options are omitted", () => {
    const previousThreshold = process.env.ANOMALY_FLAG_THRESHOLD;
    const previousWindow = process.env.ANOMALY_VELOCITY_WINDOW_MS;
    const previousBurst = process.env.ANOMALY_VELOCITY_BURST_COUNT;
    try {
      process.env.ANOMALY_FLAG_THRESHOLD = "0.2";
      process.env.ANOMALY_VELOCITY_WINDOW_MS = "1234";
      process.env.ANOMALY_VELOCITY_BURST_COUNT = "1";
      const scorer = new AnomalyScorer({ nowMs: () => FIXED_NOW });
      expect(scorer.getFlagThreshold()).toBe(0.2);
      expect(scorer.getVelocityWindowMs()).toBe(1234);
      expect(scorer.evaluate({ customerId: "c", recentIntentCount: 2 }).flagged).toBe(true);
    } finally {
      if (previousThreshold === undefined) delete process.env.ANOMALY_FLAG_THRESHOLD;
      else process.env.ANOMALY_FLAG_THRESHOLD = previousThreshold;
      if (previousWindow === undefined) delete process.env.ANOMALY_VELOCITY_WINDOW_MS;
      else process.env.ANOMALY_VELOCITY_WINDOW_MS = previousWindow;
      if (previousBurst === undefined) delete process.env.ANOMALY_VELOCITY_BURST_COUNT;
      else process.env.ANOMALY_VELOCITY_BURST_COUNT = previousBurst;
    }
  });

  it("falls back to defaults for invalid env values", () => {
    const previousThreshold = process.env.ANOMALY_FLAG_THRESHOLD;
    try {
      process.env.ANOMALY_FLAG_THRESHOLD = "not-a-number";
      expect(new AnomalyScorer().getFlagThreshold()).toBe(DEFAULT_FLAG_THRESHOLD);
    } finally {
      if (previousThreshold === undefined) delete process.env.ANOMALY_FLAG_THRESHOLD;
      else process.env.ANOMALY_FLAG_THRESHOLD = previousThreshold;
    }
  });

  it("evicts oldest tracked fingerprints beyond the cap", () => {
    const scorer = makeScorer({ maxTrackedFingerprints: 1 });
    scorer.evaluate({ customerId: "a", deviceFingerprint: "fp-1" });
    // fp-2 evicts fp-1's entry.
    scorer.evaluate({ customerId: "b", deviceFingerprint: "fp-2" });
    expect(
      scorer.evaluate({ customerId: "b", deviceFingerprint: "fp-1" }).signals.fingerprintRisk,
    ).toBe(0.25);
  });

  it("clamps non-positive index capacities to the minimum of one entry", () => {
    const scorer = makeScorer({ maxTrackedFingerprints: 0 });
    expect(
      scorer.evaluate({ customerId: "a", deviceFingerprint: "fp-1" }).signals.fingerprintRisk,
    ).toBe(0.25);
    // The retained slot keeps customer a's fingerprint, so reuse by another
    // customer is still detected as sharing.
    expect(
      scorer.evaluate({ customerId: "b", deviceFingerprint: "fp-1" }).signals.fingerprintRisk,
    ).toBe(1);
  });

  it("evicts oldest tracked customer locations beyond the cap", () => {
    const scorer = makeScorer({ maxTrackedCustomers: 1 });
    scorer.evaluate({ customerId: "a", ipAddress: "home" });
    scorer.evaluate({ customerId: "b", ipAddress: "home" }); // evicts a
    expect(scorer.evaluate({ customerId: "a", ipAddress: "antipode" }).signals.geoHopDistance).toBe(
      0,
    );
  });

  it("_reset clears in-process state", () => {
    const scorer = makeScorer();
    scorer.evaluate({ customerId: "a", deviceFingerprint: "fp", ipAddress: "home" });
    scorer._reset();
    expect(
      scorer.evaluate({ customerId: "b", deviceFingerprint: "fp" }).signals.fingerprintRisk,
    ).toBe(0.25);
    expect(scorer.evaluate({ customerId: "a", ipAddress: "antipode" }).signals.geoHopDistance).toBe(
      0,
    );
  });
});

describe("assessBookingIntentAnomaly", () => {
  const baseScorer = () =>
    new AnomalyScorer({
      resolveLocation: () => undefined,
      nowMs: () => FIXED_NOW,
    });

  it("derives velocity and buyer-age signals from persisted history", async () => {
    const scorer = baseScorer();
    const history = {
      listByCustomer: (customerId: string) =>
        customerId === "cust-1"
          ? [
              { createdAt: new Date(FIXED_NOW - 60 * 1000).toISOString() },
              { createdAt: new Date(FIXED_NOW - 2 * 60 * 1000).toISOString() },
              { createdAt: new Date(daysAgo(400)).toISOString() },
            ]
          : [],
    };

    const assessment = await assessBookingIntentAnomaly(scorer, history, {
      customerId: "cust-1",
    });

    // Three intents total, two inside the default 5-minute window:
    // velocity = (2 - 1) / burstCount(4) = 0.25.
    expect(assessment.signals.velocity).toBeCloseTo(0.25, 10);
    // Earliest intent is ~400 days old -> no buyer-age risk.
    expect(assessment.signals.buyerAge).toBe(0);
  });

  it("scores 0 when the provider has no history for the customer", async () => {
    const assessment = await assessBookingIntentAnomaly(
      baseScorer(),
      { listByCustomer: () => [] },
      { customerId: "cust-1" },
    );
    expect(assessment.score).toBe(0);
  });

  it("accepts an absent history provider (all history signals degrade to 0)", async () => {
    const assessment = await assessBookingIntentAnomaly(baseScorer(), undefined, {
      customerId: "cust-1",
    });
    expect(assessment.score).toBe(0);
    expect(assessment.signals.velocity).toBe(0);
    expect(assessment.signals.buyerAge).toBe(0);
  });

  it("degrades to a history-free assessment and logs when lookups fail", async () => {
    const warnings: unknown[] = [];
    const failingProvider = {
      listByCustomer: () => {
        throw new Error("db down");
      },
    };

    const assessment = await assessBookingIntentAnomaly(
      baseScorer(),
      failingProvider,
      { customerId: "cust-1" },
      { warn: (obj, msg) => warnings.push({ obj, msg }) },
    );

    expect(assessment.score).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      msg: "Anomaly history lookup failed; scoring without history",
    });
  });
});

describe("anomalyReviewQueue", () => {
  afterEach(() => {
    anomalyReviewQueue._reset();
  });

  const assessment = {
    score: 0.9,
    flagged: true,
    reasons: ["velocity_burst:6"],
    signals: { velocity: 1, fingerprintRisk: 0, geoHopDistance: 1, buyerAge: 0 },
  };

  it("enqueues, lists, and fetches review items", () => {
    const item = anomalyReviewQueue.enqueue("intent-1", "cust-1", assessment);
    expect(item.intentId).toBe("intent-1");
    expect(item.customerId).toBe("cust-1");
    expect(item.score).toBe(0.9);
    expect(item.reasons).toEqual(["velocity_burst:6"]);
    expect(item.flaggedAt).toBeTruthy();

    anomalyReviewQueue.enqueue("intent-2", "cust-2", assessment);
    expect(anomalyReviewQueue.listAll()).toHaveLength(2);
    expect(anomalyReviewQueue.getItem(item.id)).toEqual(item);
    expect(anomalyReviewQueue.getItem("missing")).toBeUndefined();
  });

  it("drops the oldest entries once the bounded capacity is exceeded", () => {
    for (let i = 0; i < 1001; i++) {
      anomalyReviewQueue.enqueue(`intent-${i}`, "cust", assessment);
    }
    const items = anomalyReviewQueue.listAll();
    expect(items).toHaveLength(1000);
    expect(items[0].intentId).toBe("intent-1");
  });

  it("_reset empties the queue", () => {
    anomalyReviewQueue.enqueue("intent-1", "cust-1", assessment);
    anomalyReviewQueue._reset();
    expect(anomalyReviewQueue.listAll()).toHaveLength(0);
  });
});

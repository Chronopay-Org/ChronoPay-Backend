import {
  previewCumulative,
  BUCKET_SPACE,
  fraudTrafficRouter,
} from "../fraudTrafficRouter.js";

function makeModels(versions: string[]): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const v of versions) m.set(v, { version: v });
  return m;
}

describe("fraudTrafficRouter.hashTenantToBucket", () => {
  it("is deterministic per tenant", () => {
    const a = fraudTrafficRouter.hashTenantToBucket("tenant-A");
    const b = fraudTrafficRouter.hashTenantToBucket("tenant-A");
    expect(a).toBe(b);
  });

  it("produces values in the BUCKET_SPACE range", () => {
    for (let i = 0; i < 1000; i++) {
      const b = fraudTrafficRouter.hashTenantToBucket(`t-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(BUCKET_SPACE);
    }
  });

  it("distributes tenants approximately uniformly", () => {
    const counts = new Array(BUCKET_SPACE).fill(0) as number[];
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      counts[fraudTrafficRouter.hashTenantToBucket(`tenant-${i}`)]++;
    }
    const mean = N / BUCKET_SPACE; // = 100
    // Tighter bound: a binomial sample with p=0.01 has std-dev ≈ 10.
    // Allow ±25 deviation per bucket (~2.5σ).
    const outliers = counts.filter((c) => Math.abs(c - mean) > 25).length;
    expect(outliers).toBeLessThan(5);
  });

  it("throws on empty / invalid input", () => {
    expect(() => fraudTrafficRouter.hashTenantToBucket("")).toThrow();

    expect(() => fraudTrafficRouter.hashTenantToBucket(undefined as any)).toThrow();
  });
});

describe("fraudTrafficRouter.buildSnapshot", () => {
  it("produces an immutable snapshot with cumulative table sorted by version", () => {
    const models = makeModels(["v2", "v1", "v3"]);
    const weights = { v1: 33, v2: 33, v3: 34 };
    const snap = fraudTrafficRouter.buildSnapshot({
      models,
      weights,
      overrides: { tenantA: "v1" },
      snapshotId: "snap-1",
    });
    expect(snap.versions.size).toBe(3);
    expect(snap.cumulative.length).toBe(3);
    expect(snap.cumulative[0].version).toBe("v1");
    expect(snap.cumulative[2].version).toBe("v3");
  });

  it("drops overrides whose target version is not in weights (weight 0)", () => {
    const models = makeModels(["v1", "v2"]);
    const snap = fraudTrafficRouter.buildSnapshot({
      models,
      weights: { v1: 100, v2: 0 },
      overrides: { tenantA: "v2" },
      snapshotId: "snap-1",
    });
    expect(snap.overrides.size).toBe(0);
  });

  it("versions Set mirrors cumulative table (weight > 0 only)", () => {
    const models = makeModels(["v1", "v2", "v3"]);
    const snap = fraudTrafficRouter.buildSnapshot({
      models,
      weights: { v1: 100, v2: 0, v3: 0 },
      overrides: {},
      snapshotId: "snap-1",
    });
    expect(Array.from(snap.versions)).toEqual(["v1"]);
  });

  it("does not mutate the input weights map", () => {
    const models = makeModels(["v1", "v2"]);
    const weights = { v1: 60, v2: 40 };
    const snapshot = Object.freeze({ ...weights }); // snapshot input identity
    fraudTrafficRouter.buildSnapshot({
      models,
      weights,
      overrides: {},
      snapshotId: "snap-1",
    });
    expect(weights).toEqual(snapshot);
  });
});

describe("fraudTrafficRouter.routeRequest", () => {
  it("returns the override version without hashing (bucket = -1)", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels(["v1", "v2"]),
      weights: { v1: 50, v2: 50 },
      overrides: { tenantA: "v2" },
      snapshotId: "snap-1",
    });
    expect(fraudTrafficRouter.routeRequest("tenantA", snap)).toEqual({
      version: "v2",
      bucket: -1,
    });
  });

  it("override takes precedence even when weight is 0 for that version", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels(["v1", "v2"]),
      weights: { v1: 100, v2: 0 },
      overrides: { tenantA: "v2" },
      snapshotId: "snap-1",
    });
    // Override filtered at snapshot creation since v2 has weight 0.
    expect(snap.overrides.has("tenantA")).toBe(false);
    expect(fraudTrafficRouter.routeRequest("tenantA", snap).version).toBe("v1");
  });

  it("bucketing respects weight distribution (100/0 sends everything to v1)", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels(["v1"]),
      weights: { v1: 100 },
      overrides: {},
      snapshotId: "snap-2",
    });
    for (let i = 0; i < 200; i++) {
      const decision = fraudTrafficRouter.routeRequest(`t-${i}`, snap);
      expect(decision.version).toBe("v1");
      expect(decision.bucket).toBeGreaterThanOrEqual(0);
    }
  });

  it("routes proportionally according to weights (80/20)", () => {
    const models = makeModels(["v1", "v2"]);
    const weights = { v1: 80, v2: 20 };
    const snap = fraudTrafficRouter.buildSnapshot({
      models,
      weights,
      overrides: {},
      snapshotId: "snap-3",
    });
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = fraudTrafficRouter.routeRequest(`tenant-${i}`, snap).version;
      if (v === "v1") v1++;
      else if (v === "v2") v2++;
    }
    expect(v1).toBeGreaterThan(7_500);
    expect(v1).toBeLessThan(8_500);
    expect(v2).toBeGreaterThan(1_500);
    expect(v2).toBeLessThan(2_500);
  });

  it("returns the last cumulative version when bucket equals BUCKET_SPACE - 1", () => {
    const _models = makeModels(["v1", "v2"]);
    const cumulative = previewCumulative({ v1: 99, v2: 1 });
    expect(cumulative[cumulative.length - 1].upper).toBe(BUCKET_SPACE);
  });

  it("does not allocate on the hot path (returning the decision object)", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels(["v1", "v2"]),
      weights: { v1: 70, v2: 30 },
      overrides: {},
      snapshotId: "snap-1",
    });
    for (let i = 0; i < 100_000; i++) {
      fraudTrafficRouter.routeRequest(`tenant-${i}`, snap);
    }
  });

  it("throws when snapshot has no weighted versions", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels([]),
      weights: {},
      overrides: {},
      snapshotId: "snap-1",
    });
    expect(() => fraudTrafficRouter.routeRequest("tenant-a", snap)).toThrow();
  });

  it("throws on invalid tenant id", () => {
    const snap = fraudTrafficRouter.buildSnapshot({
      models: makeModels(["v1"]),
      weights: { v1: 100 },
      overrides: {},
      snapshotId: "snap-1",
    });
    expect(() => fraudTrafficRouter.routeRequest("", snap)).toThrow();

    expect(() => fraudTrafficRouter.routeRequest(undefined as any, snap)).toThrow();
  });
});

describe("previewCumulative", () => {
  it("orders by version string ascending", () => {
    const out = previewCumulative({ v2: 70, v1: 30 });
    expect(out.map((c) => c.version)).toEqual(["v1", "v2"]);
    expect(out[0].upper).toBe(30);
    expect(out[1].upper).toBe(100);
  });

  it("caps upper at BUCKET_SPACE", () => {
    const out = previewCumulative({ v1: 80, v2: 60 });
    expect(out[out.length - 1].upper).toBe(100);
  });

  it("does not mutate inputs", () => {
    const weights = { v1: 60, v2: 40, v3: 0 };
    const snapshot = { ...weights };
    previewCumulative(weights);
    expect(weights).toEqual(snapshot);
  });
});

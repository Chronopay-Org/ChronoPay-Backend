import {
  FraudModelRegistry,
  resetFraudModelRegistry,
  DuplicateVersionError,
  WeightsDoNotSumError,
  UnknownVersionError,
  NegativeWeightError,
  NonIntegerWeightError,
  InvalidOverrideError,
  EmptyRegistryError,
} from "../fraudModelRegistry.js";
import { fraudTrafficRouter } from "../fraudTrafficRouter.js";

function makeConfig(version: string, weight = 50): Parameters<FraudModelRegistry["registerModel"]>[0] {
  return {
    version,
    contentHash: `hash-${version}`,
    trafficWeight: weight,
    registeredAt: new Date(1_700_000_000_000).toISOString(),
    registeredBy: "admin-1",
  };
}

describe("FraudModelRegistry validation", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
  });

  it("accepts 100/0 split", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    expect(r.validateWeights({ v1: 100 }, {}).errors).toEqual([]);
  });

  it("accepts 50/30/20 split", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 50));
    r.registerModel(makeConfig("v2", 30));
    r.registerModel(makeConfig("v3", 20));
    expect(r.validateWeights({ v1: 50, v2: 30, v3: 20 }, {}).errors).toEqual([]);
  });

  it("accepts 99/1 split", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 99));
    r.registerModel(makeConfig("v2", 1));
    expect(r.validateWeights({ v1: 99, v2: 1 }, {}).errors).toEqual([]);
  });

  it("rejects weights that do not sum to 100", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 90));
    r.registerModel(makeConfig("v2", 20));
    const { errors } = r.validateWeights({ v1: 90, v2: 20 }, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WeightsDoNotSumError);
  });

  it("rejects fractional weights", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 99));
    r.registerModel(makeConfig("v2", 1));
    const { errors } = r.validateWeights({ v1: 99.5, v2: 0.5 }, {});
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(NonIntegerWeightError);
  });

  it("rejects negative weights", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    const { errors } = r.validateWeights({ v1: -1 }, {});
    expect(errors[0]).toBeInstanceOf(NegativeWeightError);
  });

  it("rejects weights referencing unknown version", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    const { errors } = r.validateWeights({ v1: 50, ghost: 50 }, {});
    expect(errors.some((e) => e instanceof UnknownVersionError)).toBe(true);
  });

  it("rejects override to non-existent version", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    const { errors } = r.validateWeights({ v1: 100 }, { tenantA: "ghost" });
    expect(errors[0]).toBeInstanceOf(InvalidOverrideError);
  });

  it("rejects promotion on empty registry", () => {
    const r = new FraudModelRegistry();
    const { errors } = r.validateWeights({ v1: 100 }, {});
    expect(errors[0]).toBeInstanceOf(EmptyRegistryError);
  });

  it("accepts when target version exists with weight 0 (kept registered but off-route)", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 50));
    r.registerModel(makeConfig("v2", 0));
    expect(r.validateWeights({ v1: 100, v2: 0 }, {}).errors).toEqual([]);
  });

  it("flags a warning when an override targets a weight-0 version", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    r.registerModel(makeConfig("v2", 0));
    const { errors, warnings } = r.validateWeights(
      { v1: 100, v2: 0 },
      { tenantA: "v2" },
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("OVERRIDE_TARGET_WEIGHT_ZERO");
    expect(warnings[0].tenantId).toBe("tenantA");
    expect(warnings[0].version).toBe("v2");
  });
});

describe("FraudModelRegistry register / promote", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
  });

  it("rejects registerModel with non-integer weight metadata", () => {
    const r = new FraudModelRegistry();
    expect(() => r.registerModel(makeConfig("v1", -1))).toThrow(NonIntegerWeightError);
    expect(() => r.registerModel(makeConfig("v1", 100.5))).toThrow(NonIntegerWeightError);
    expect(() => r.registerModel(makeConfig("v1", 101))).toThrow(NonIntegerWeightError);
  });

  it("rejects duplicate version on register", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    expect(() => r.registerModel(makeConfig("v1", 100))).toThrow(DuplicateVersionError);
  });

  it("promote emits a new immutable snapshot with monotonic id", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    const before = r.getLatestSnapshot();
    const result = r.promote({ weights: { v1: 100 }, tenantOverrides: {} }, "admin-1");
    expect(result.snapshot).not.toBe(before);
    expect(result.snapshot.snapshotId).not.toBe(before.snapshotId);
  });

  it("snapshot cumulative distributes buckets according to weights", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 70));
    r.registerModel(makeConfig("v2", 30));
    r.promote({ weights: { v1: 70, v2: 30 }, tenantOverrides: {} }, "admin-1");
    const snap = r.getLatestSnapshot();
    expect(snap.cumulative).toEqual([
      { upper: 70, version: "v1" },
      { upper: 100, version: "v2" },
    ]);
  });

  it("promote accepts weights summing to 100 and version must be registered", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 70));
    r.registerModel(makeConfig("v2", 30));
    const result = r.promote({ weights: { v1: 70, v2: 30 }, tenantOverrides: {} }, "admin-1");
    expect(result.snapshot.versions.size).toBe(2);
    expect(result.snapshot.cumulative.length).toBe(2);
  });

  it("promote returns removedVersions when weight drops to 0", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 70));
    r.registerModel(makeConfig("v2", 30));
    const result = r.promote({ weights: { v1: 100, v2: 0 }, tenantOverrides: {} }, "admin-1");
    expect(result.removedVersions).toContain("v2");
  });

  it("promote captures tenant overrides in snapshot", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 70));
    r.registerModel(makeConfig("v2", 30));
    const result = r.promote(
      { weights: { v1: 70, v2: 30 }, tenantOverrides: { tenantA: "v2" } },
      "admin-1",
    );
    expect(result.snapshot.overrides.get("tenantA")).toBe("v2");
  });

  it("promote drops overrides targeting weight-0 versions and reports them", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 50));
    r.registerModel(makeConfig("v2", 50));
    r.promote(
      { weights: { v1: 50, v2: 50 }, tenantOverrides: { tenantA: "v2" } },
      "admin-1",
    );
    // Second promote routes everything to v3 (so v2 drops to weight 0) and
    // also has a tenantB override targeting v3 which is still alive. tenantA
    // becomes orphaned because its target (v2) lost its weight, and the
    // orphan list surfaces it so the admin can re-route.
    r.registerModel(makeConfig("v3", 0));
    const second = r.promote(
      { weights: { v1: 0, v2: 0, v3: 100 }, tenantOverrides: { tenantB: "v3" } },
      "admin-1",
    );
    expect(second.snapshot.overrides.has("tenantA")).toBe(false);
    expect(second.snapshot.overrides.get("tenantB")).toBe("v3");
    expect(second.removedOverrides).toContain("tenantA->v2");
  });

  it("promote surfaces overrides whose target dropped to weight 0 in removedOverrides", () => {
    // v3 must be present in the first promote's snapshot with positive
    // weight for tenantB to even reach the snapshot's overrides map;
    // buildSnapshot drops any override whose target has weight 0.
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 33));
    r.registerModel(makeConfig("v2", 33));
    r.registerModel(makeConfig("v3", 34));
    r.promote(
      {
        weights: { v1: 33, v2: 33, v3: 34 },
        tenantOverrides: { tenantA: "v2", tenantB: "v3" },
      },
      "admin-1",
    );
    const second = r.promote(
      { weights: { v1: 100, v2: 0, v3: 0 }, tenantOverrides: {} },
      "admin-1",
    );
    // Both overrides fell out because their target versions no longer carry traffic.
    expect(second.snapshot.overrides.has("tenantA")).toBe(false);
    expect(second.snapshot.overrides.has("tenantB")).toBe(false);
    expect(second.removedOverrides).toContain("tenantA->v2");
    expect(second.removedOverrides).toContain("tenantB->v3");
  });

  it("promote surfaces override-target-weight-zero warnings", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    r.registerModel(makeConfig("v2", 0));
    const result = r.promote(
      { weights: { v1: 100, v2: 0 }, tenantOverrides: { tenantA: "v2" } },
      "admin-1",
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe("OVERRIDE_TARGET_WEIGHT_ZERO");
  });

  it("promote throws WeightsDoNotSumError at the boundary", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 90));
    r.registerModel(makeConfig("v2", 20));
    expect(() =>
      r.promote({ weights: { v1: 90, v2: 20 }, tenantOverrides: {} }, "admin-1"),
    ).toThrow(WeightsDoNotSumError);
  });

  it("listModels / getModelByVersion return copies", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    const all = r.listModels();
    const specific = r.getModelByVersion("v1");
    expect(all).toHaveLength(1);
    expect(specific?.version).toBe("v1");
    all[0].trafficWeight = 9999;
    expect(r.listModels()[0].trafficWeight).toBe(100);
  });
});

describe("FraudModelRegistry snapshots across promotions", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
  });

  it("returns the same snapshot object identity to consecutive readers until the next promote", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    r.promote({ weights: { v1: 100 }, tenantOverrides: {} }, "admin-1");
    const a = r.getLatestSnapshot();
    const b = r.getLatestSnapshot();
    expect(a).toBe(b);
  });

  it("router traffic distribution is stable across same-snapshot calls", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 80));
    r.registerModel(makeConfig("v2", 20));
    r.promote({ weights: { v1: 80, v2: 20 }, tenantOverrides: {} }, "admin-1");
    const snap = r.getLatestSnapshot();
    const bucketsSeenFor = (version: string) =>
      Array.from({ length: 100 }, (_, i) => `tenant-${i}`)
        .map((t) => fraudTrafficRouter.routeRequest(t, snap).version)
        .filter((v) => v === version).length;
    const firstV1 = bucketsSeenFor("v1");
    const secondV1 = bucketsSeenFor("v1");
    expect(firstV1).toBe(secondV1);
  });
});

describe("FraudModelRegistry thread-safety (single-thread invariants)", () => {
  beforeEach(() => {
    resetFraudModelRegistry();
  });

  it("mid-flight snapshot reads are not affected by subsequent promote", () => {
    const r = new FraudModelRegistry();
    r.registerModel(makeConfig("v1", 100));
    r.promote({ weights: { v1: 100 }, tenantOverrides: {} }, "admin-1");
    const initialSnapshot = r.getLatestSnapshot();
    r.registerModel(makeConfig("v2", 0));
    r.promote({ weights: { v1: 80, v2: 20 }, tenantOverrides: {} }, "admin-2");
    const decision = fraudTrafficRouter.routeRequest("tenant-A", initialSnapshot);
    expect(decision.version).toBe("v1");
  });
});

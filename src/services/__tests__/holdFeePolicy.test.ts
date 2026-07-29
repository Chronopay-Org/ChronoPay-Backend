// @ts-nocheck
import { jest } from "@jest/globals";
import {
  HoldFeePolicyService,
  HoldFeePolicyRegistry,
  HoldFeePolicy,
  HoldFeePolicySnapshot,
  createEmptyHoldFeeRegistry,
  resolveHoldFeeCents,
  validateHoldFeePolicy,
} from "../holdFeePolicy.js";
import { applyHoldFeeToRefund } from "../cancellationPolicy.js";

function makeAuditLogger() {
  return { log: jest.fn().mockResolvedValue(undefined) } as any;
}

describe("resolveHoldFeeCents", () => {
  it("returns 0 for supplier with no policy", () => {
    const reg = createEmptyHoldFeeRegistry();
    expect(resolveHoldFeeCents(reg, "supplier-1")).toBe(0);
  });

  it("returns configured holdFeeCents when policy exists", () => {
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-1": {
          supplierId: "supplier-1",
          holdFeeCents: 500,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    expect(resolveHoldFeeCents(reg, "supplier-1")).toBe(500);
  });

  it("clamps negative holdFeeCents to 0", () => {
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-1": {
          supplierId: "supplier-1",
          holdFeeCents: -100,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    expect(resolveHoldFeeCents(reg, "supplier-1")).toBe(0);
  });
});

describe("validateHoldFeePolicy", () => {
  it("accepts valid policy", () => {
    const policy: HoldFeePolicy = {
      supplierId: "supplier-1",
      holdFeeCents: 500,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateHoldFeePolicy(policy)).not.toThrow();
  });

  it("rejects missing supplierId", () => {
    const policy: HoldFeePolicy = {
      supplierId: "",
      holdFeeCents: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateHoldFeePolicy(policy)).toThrow();
  });

  it("rejects negative holdFeeCents", () => {
    const policy: HoldFeePolicy = {
      supplierId: "supplier-1",
      holdFeeCents: -1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateHoldFeePolicy(policy)).toThrow();
  });

  it("rejects NaN holdFeeCents", () => {
    const policy: HoldFeePolicy = {
      supplierId: "supplier-1",
      holdFeeCents: NaN,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateHoldFeePolicy(policy)).toThrow();
  });

  it("rejects holdFeeCents exceeding maximum", () => {
    const policy: HoldFeePolicy = {
      supplierId: "supplier-1",
      holdFeeCents: 1_000_000_001,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(() => validateHoldFeePolicy(policy)).toThrow();
  });
});

describe("HoldFeePolicyService.snapshotForSupplier", () => {
  it("returns snapshot with 0 hold fee when supplier has no policy", () => {
    const svc = new HoldFeePolicyService({
      getRegistry: () => createEmptyHoldFeeRegistry(),
      nowMs: () => 1000,
    });
    const snap = svc.snapshotForSupplier("supplier-1");
    expect(snap.supplierId).toBe("supplier-1");
    expect(snap.holdFeeCents).toBe(0);
    expect(snap.capturedAtMs).toBe(1000);
  });

  it("returns snapshot with configured hold fee", () => {
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-1": {
          supplierId: "supplier-1",
          holdFeeCents: 250,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const svc = new HoldFeePolicyService({
      getRegistry: () => reg,
      nowMs: () => 2000,
    });
    const snap = svc.snapshotForSupplier("supplier-1");
    expect(snap.holdFeeCents).toBe(250);
    expect(snap.capturedAtMs).toBe(2000);
  });
});

describe("HoldFeePolicyService.computeRetention", () => {
  it("returns 0 for undefined snapshot", () => {
    const svc = new HoldFeePolicyService();
    expect(svc.computeRetention(undefined)).toBe(0);
  });

  it("returns holdFeeCents from snapshot", () => {
    const svc = new HoldFeePolicyService();
    const snap: HoldFeePolicySnapshot = {
      supplierId: "supplier-1",
      holdFeeCents: 100,
      capturedAtMs: 1000,
    };
    expect(svc.computeRetention(snap)).toBe(100);
  });
});

describe("HoldFeePolicyService.deductRetention", () => {
  it("returns full refund when no snapshot", () => {
    const svc = new HoldFeePolicyService();
    expect(svc.deductRetention(1000, undefined)).toBe(1000);
  });

  it("deducts hold fee from refund", () => {
    const svc = new HoldFeePolicyService();
    const snap: HoldFeePolicySnapshot = {
      supplierId: "supplier-1",
      holdFeeCents: 200,
      capturedAtMs: 1000,
    };
    expect(svc.deductRetention(1000, snap)).toBe(800);
  });

  it("clamps to 0 when hold fee exceeds refund", () => {
    const svc = new HoldFeePolicyService();
    const snap: HoldFeePolicySnapshot = {
      supplierId: "supplier-1",
      holdFeeCents: 5000,
      capturedAtMs: 1000,
    };
    expect(svc.deductRetention(1000, snap)).toBe(0);
  });
});

describe("HoldFeePolicyService.upsertPolicy", () => {
  it("adds new policy for supplier", () => {
    const svc = new HoldFeePolicyService({
      auditLogger: makeAuditLogger(),
    });
    const reg = createEmptyHoldFeeRegistry();
    const updated = svc.upsertPolicy(reg, {
      supplierId: "supplier-1",
      holdFeeCents: 300,
    });
    expect(updated.entries["supplier-1"].holdFeeCents).toBe(300);
  });

  it("updates existing policy for supplier", () => {
    const svc = new HoldFeePolicyService({
      auditLogger: makeAuditLogger(),
    });
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-1": {
          supplierId: "supplier-1",
          holdFeeCents: 100,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const updated = svc.upsertPolicy(reg, {
      supplierId: "supplier-1",
      holdFeeCents: 500,
    });
    expect(updated.entries["supplier-1"].holdFeeCents).toBe(500);
  });

  it("clamps negative holdFeeCents to 0", () => {
    const svc = new HoldFeePolicyService({
      auditLogger: makeAuditLogger(),
    });
    const reg = createEmptyHoldFeeRegistry();
    const updated = svc.upsertPolicy(reg, {
      supplierId: "supplier-1",
      holdFeeCents: -50,
    });
    expect(updated.entries["supplier-1"].holdFeeCents).toBe(0);
  });
});

describe("HoldFeePolicyService.getPolicy / listPolicies", () => {
  it("returns undefined for unknown supplier", () => {
    const svc = new HoldFeePolicyService();
    const reg = createEmptyHoldFeeRegistry();
    expect(svc.getPolicy(reg, "unknown")).toBeUndefined();
  });

  it("returns policy for known supplier", () => {
    const svc = new HoldFeePolicyService();
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-1": {
          supplierId: "supplier-1",
          holdFeeCents: 100,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const policy = svc.getPolicy(reg, "supplier-1");
    expect(policy).toBeDefined();
    expect(policy!.holdFeeCents).toBe(100);
  });

  it("lists policies sorted by supplierId", () => {
    const svc = new HoldFeePolicyService();
    const reg: HoldFeePolicyRegistry = {
      entries: {
        "supplier-b": { supplierId: "supplier-b", holdFeeCents: 200, updatedAt: "2026-01-01T00:00:00.000Z" },
        "supplier-a": { supplierId: "supplier-a", holdFeeCents: 100, updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    };
    const policies = svc.listPolicies(reg);
    expect(policies[0].supplierId).toBe("supplier-a");
    expect(policies[1].supplierId).toBe("supplier-b");
  });
});

describe("applyHoldFeeToRefund (from cancellationPolicy.ts)", () => {
  it("deducts hold fee and updates netRefund", () => {
    const breakdown = {
      fee: 50,
      taxReversal: 100,
      netRefund: 1000,
      policyVersion: "v1",
      tierApplied: null,
      hoursUntilStart: 48,
      basePrice: 2000,
      holdFee: 0,
    };
    const result = applyHoldFeeToRefund(breakdown, 200);
    expect(result.holdFee).toBe(200);
    expect(result.netRefund).toBe(800);
    expect(result.fee).toBe(50);
  });

  it("clamps netRefund to 0 when hold fee exceeds net refund", () => {
    const breakdown = {
      fee: 0,
      taxReversal: 0,
      netRefund: 100,
      policyVersion: "v1",
      tierApplied: null,
      hoursUntilStart: 24,
      basePrice: 1000,
      holdFee: 0,
    };
    const result = applyHoldFeeToRefund(breakdown, 500);
    expect(result.holdFee).toBe(500);
    expect(result.netRefund).toBe(0);
  });

  it("ignores negative holdFeeCents", () => {
    const breakdown = {
      fee: 0,
      taxReversal: 0,
      netRefund: 1000,
      policyVersion: "v1",
      tierApplied: null,
      hoursUntilStart: 24,
      basePrice: 2000,
      holdFee: 0,
    };
    const result = applyHoldFeeToRefund(breakdown, -100);
    expect(result.holdFee).toBe(0);
    expect(result.netRefund).toBe(1000);
  });
});
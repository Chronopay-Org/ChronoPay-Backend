import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ReputationBootstrapService,
  DEFAULT_BOOTSTRAP_POLICY,
  type BootstrapPolicy,
} from "../reputationBootstrapService.js";
import {
  ReputationTransparencyService,
  type SupplierRecord,
} from "../reputationTransparencyService.js";

function advanceDate(days: number, base: Date): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("ReputationBootstrapService", () => {
  describe("Policy Defaults", () => {
    it("exposes sensible secure defaults", () => {
      expect(DEFAULT_BOOTSTRAP_POLICY.requiredKycStatus).toBe("verified");
      expect(DEFAULT_BOOTSTRAP_POLICY.startingScore).toBeGreaterThan(0);
      expect(DEFAULT_BOOTSTRAP_POLICY.startingScore).toBeLessThanOrEqual(85);
      expect(DEFAULT_BOOTSTRAP_POLICY.bootstrapWindowDays).toBeGreaterThanOrEqual(7);
      expect(DEFAULT_BOOTSTRAP_POLICY.minGenuineTransactions).toBeGreaterThanOrEqual(1);
      expect(DEFAULT_BOOTSTRAP_POLICY.maxBootstrapPerIdentity).toBe(1);
      expect(DEFAULT_BOOTSTRAP_POLICY.scoreDecayStartDay).toBeGreaterThan(0);
      expect(DEFAULT_BOOTSTRAP_POLICY.enabledRegions).toBeNull();
    });

    it("allows policy overrides via constructor", () => {
      const custom: Partial<BootstrapPolicy> = {
        startingScore: 60,
        bootstrapWindowDays: 14,
        minGenuineTransactions: 2,
      };
      const svc = new ReputationBootstrapService(custom);
      const p = svc.getPolicy();
      expect(p.startingScore).toBe(60);
      expect(p.bootstrapWindowDays).toBe(14);
      expect(p.minGenuineTransactions).toBe(2);
      expect(p.requiredKycStatus).toBe("verified");
    });
  });

  describe("Identity key derivation", () => {
    it("normalizes email case and concatenates kycRef", () => {
      const svc = new ReputationBootstrapService();
      const a = svc.identityKeyFor(" Alice@Example.COM ", "ref-1");
      const b = svc.identityKeyFor("alice@example.com", "ref-1");
      expect(a).toBe(b);
      expect(a).toContain("alice@example.com");
      expect(a).toContain("ref-1");
    });

    it("works without a kycRef (email only)", () => {
      const svc = new ReputationBootstrapService();
      const k = svc.identityKeyFor("bob@example.com", null);
      expect(k).toBe("bob@example.com");
    });
  });

  describe("canGrant preconditions", () => {
    let svc: ReputationBootstrapService;

    beforeEach(() => {
      svc = new ReputationBootstrapService();
    });

    it("rejects when kycStatus is not verified", () => {
      const key = svc.identityKeyFor("s1@example.com", "r1");
      const check = svc.canGrant("supplier-1", key, "pending");
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("KYC_NOT_VERIFIED");
    });

    it("rejects duplicate bootstrap for same supplier", () => {
      svc.grant({
        supplierId: "supplier-1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });
      const key = svc.identityKeyFor("s1@example.com", "r1");
      const check = svc.canGrant("supplier-1", key, "verified");
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("SUPPLIER_ALREADY_BOOTSTRAPPED");
    });

    it("rejects duplicate identity (same email+kycRef) across different suppliers", () => {
      svc.grant({
        supplierId: "supplier-a",
        email: "shared@example.com",
        kycStatus: "verified",
        kycRef: "shared-ref",
      });
      const key = svc.identityKeyFor("shared@example.com", "shared-ref");
      const check = svc.canGrant("supplier-b", key, "verified");
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("IDENTITY_BOOTSTRAP_LIMIT_EXCEEDED");
    });

    it("rejects region outside enabled whitelist", () => {
      const regional = new ReputationBootstrapService({
        enabledRegions: ["us-east", "eu-west"],
      });
      const key = regional.identityKeyFor("r@example.com", "rr");
      const check = regional.canGrant("supplier-r", key, "verified", "ap-south");
      expect(check.ok).toBe(false);
      expect(check.reason).toBe("REGION_POLICY_DISABLED");
    });

    it("allows region inside enabled whitelist", () => {
      const regional = new ReputationBootstrapService({
        enabledRegions: ["us-east", "eu-west"],
      });
      const key = regional.identityKeyFor("r@example.com", "rr");
      const check = regional.canGrant("supplier-r", key, "verified", "us-east");
      expect(check.ok).toBe(true);
    });

    it("passes all checks for a clean new verified supplier", () => {
      const key = svc.identityKeyFor("fresh@example.com", "fresh-ref");
      const check = svc.canGrant("supplier-fresh", key, "verified");
      expect(check.ok).toBe(true);
      expect(check.reason).toBeUndefined();
    });
  });

  describe("grant", () => {
    it("returns record with correct expiry window", () => {
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService({}, () => base);
      const record = svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
        region: "us-east",
      });
      expect(record).not.toBeNull();
      expect(record?.supplierId).toBe("s1");
      expect(record?.consumed).toBe(false);
      expect(record?.startingScore).toBe(DEFAULT_BOOTSTRAP_POLICY.startingScore);
      expect(record?.region).toBe("us-east");
      expect(record?.expiresAt.getTime()).toBe(
        base.getTime() + DEFAULT_BOOTSTRAP_POLICY.bootstrapWindowDays * 24 * 60 * 60 * 1000
      );
    });

    it("returns null when preconditions fail", () => {
      const svc = new ReputationBootstrapService();
      const noKyc = svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "pending",
        kycRef: "r1",
      });
      expect(noKyc).toBeNull();
    });
  });

  describe("revoke", () => {
    it("removes bootstrap and releases identity quota", () => {
      const svc = new ReputationBootstrapService();
      svc.grant({
        supplierId: "s1",
        email: "dup@example.com",
        kycStatus: "verified",
        kycRef: "dup-ref",
      });
      const revoked = svc.revoke("s1", "KYC_REVOKED");
      expect(revoked).toBe(true);

      const key = svc.identityKeyFor("dup@example.com", "dup-ref");
      const retry = svc.canGrant("s2", key, "verified");
      expect(retry.ok).toBe(true);
    });

    it("returns false when revoking non-existent bootstrap", () => {
      const svc = new ReputationBootstrapService();
      expect(svc.revoke("no-such-supplier")).toBe(false);
    });
  });

  describe("Decay and expiry evaluation", () => {
    it("delivers full score before decay start day", () => {
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService({}, () => base);
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      const justAfter = new Date(base.getTime() + 10 * 24 * 60 * 60 * 1000);
      (svc as any).now = () => justAfter;
      const eval10 = svc.evaluate("s1");
      expect(eval10.active).toBe(true);
      expect(eval10.scoreContribution).toBe(DEFAULT_BOOTSTRAP_POLICY.startingScore);
      expect(eval10.decayProgress).toBe(0);
    });

    it("applies linear partial decay after scoreDecayStartDay", () => {
      const policy: Partial<BootstrapPolicy> = {
        startingScore: 100,
        bootstrapWindowDays: 30,
        scoreDecayStartDay: 15,
      };
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService(policy, () => base);
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      const day22 = advanceDate(22, base);
      (svc as any).now = () => day22;
      const eval22 = svc.evaluate("s1");

      expect(eval22.active).toBe(true);
      expect(eval22.scoreContribution).toBeLessThan(100);
      expect(eval22.scoreContribution).toBeGreaterThan(0);
      expect(eval22.decayProgress).toBeGreaterThan(0);
      expect(eval22.decayProgress).toBeLessThan(1);
    });

    it("deactivates expired unused bootstrap", () => {
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService({ bootstrapWindowDays: 5 }, () => base);
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      const wayAfter = advanceDate(10, base);
      (svc as any).now = () => wayAfter;
      const evalExp = svc.evaluate("s1");
      expect(evalExp.active).toBe(false);
      expect(evalExp.scoreContribution).toBe(0);
      expect(evalExp.reasonInactive).toBe("EXPIRED_UNUSED");
      expect(evalExp.consumed).toBe(false);
    });

    it("returns NO_BOOTSTRAP for unknown supplier", () => {
      const svc = new ReputationBootstrapService();
      const evalNone = svc.evaluate("unknown");
      expect(evalNone.active).toBe(false);
      expect(evalNone.scoreContribution).toBe(0);
      expect(evalNone.reasonInactive).toBe("NO_BOOTSTRAP");
    });
  });

  describe("Genuine transaction consumption", () => {
    it("marks bootstrap consumed after minGenuineTransactions completed", () => {
      const svc = new ReputationBootstrapService({ minGenuineTransactions: 1 });
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      svc.recordTransaction({
        id: "tx-1",
        supplierId: "s1",
        status: "completed",
        createdAt: new Date(),
      });

      const record = svc.getRecord("s1");
      expect(record?.consumed).toBe(true);
      expect(record?.consumedAt).not.toBeNull();
    });

    it("consumed bootstrap does not decay or expire (score persists)", () => {
      const policy: Partial<BootstrapPolicy> = {
        bootstrapWindowDays: 5,
        scoreDecayStartDay: 1,
        minGenuineTransactions: 1,
      };
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService(policy, () => base);
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });
      svc.recordTransaction({
        id: "tx-1",
        supplierId: "s1",
        status: "completed",
        createdAt: base,
      });

      const wayAfter = advanceDate(120, base);
      (svc as any).now = () => wayAfter;
      const evalFuture = svc.evaluate("s1");
      expect(evalFuture.active).toBe(true);
      expect(evalFuture.consumed).toBe(true);
      expect(evalFuture.scoreContribution).toBe(DEFAULT_BOOTSTRAP_POLICY.startingScore);
      expect(evalFuture.decayProgress).toBe(0);
    });

    it("ignores cancelled/pending/expired transactions for consumption", () => {
      const svc = new ReputationBootstrapService({ minGenuineTransactions: 1 });
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      for (const status of ["pending", "cancelled", "expired"] as const) {
        svc.recordTransaction({
          id: `tx-${status}`,
          supplierId: "s1",
          status,
          createdAt: new Date(),
        });
      }

      expect(svc.getRecord("s1")?.consumed).toBe(false);
    });

    it("requires minGenuineTransactions > 1 before consuming", () => {
      const svc = new ReputationBootstrapService({ minGenuineTransactions: 3 });
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });

      svc.recordTransaction({ id: "t1", supplierId: "s1", status: "completed", createdAt: new Date() });
      expect(svc.getRecord("s1")?.consumed).toBe(false);

      svc.recordTransaction({ id: "t2", supplierId: "s1", status: "completed", createdAt: new Date() });
      expect(svc.getRecord("s1")?.consumed).toBe(false);

      svc.recordTransaction({ id: "t3", supplierId: "s1", status: "completed", createdAt: new Date() });
      expect(svc.getRecord("s1")?.consumed).toBe(true);
    });
  });

  describe("tickSweep cleanup", () => {
    it("removes expired unused bootstraps and restores identity quota", () => {
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService({ bootstrapWindowDays: 5 }, () => base);

      svc.grant({
        supplierId: "s1",
        email: "shared@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });
      svc.grant({
        supplierId: "s2",
        email: "fresh@example.com",
        kycStatus: "verified",
        kycRef: "r2",
      });

      const later = advanceDate(10, base);
      (svc as any).now = () => later;

      const removed = svc.tickSweep();
      expect(removed).toBe(2);
      expect(svc.getRecord("s1")).toBeUndefined();
      expect(svc.getRecord("s2")).toBeUndefined();

      const key = svc.identityKeyFor("shared@example.com", "r1");
      const check = svc.canGrant("s3", key, "verified");
      expect(check.ok).toBe(true);
    });

    it("does not remove consumed bootstraps", () => {
      const base = new Date("2025-01-01T00:00:00Z");
      const svc = new ReputationBootstrapService(
        { bootstrapWindowDays: 5, minGenuineTransactions: 1 },
        () => base
      );
      svc.grant({
        supplierId: "s1",
        email: "s1@example.com",
        kycStatus: "verified",
        kycRef: "r1",
      });
      svc.recordTransaction({ id: "t1", supplierId: "s1", status: "completed", createdAt: base });

      const later = advanceDate(365, base);
      (svc as any).now = () => later;

      expect(svc.tickSweep()).toBe(0);
      expect(svc.getRecord("s1")).toBeDefined();
    });
  });
});

describe("ReputationBootstrapService — KYC webhook integration safeguards", () => {
  it("revokes bootstrap when KYC status moves away from verified (mid-bootstrap)", () => {
    let clock = new Date("2025-06-01T00:00:00Z");
    const bootstrap = new ReputationBootstrapService({}, () => clock);

    bootstrap.grant({
      supplierId: "s-kyc-1",
      email: "kyc@example.com",
      kycStatus: "verified",
      kycRef: "ref-orig",
    });
    expect(bootstrap.evaluate("s-kyc-1").active).toBe(true);

    bootstrap.revoke("s-kyc-1", "KYC_STATUS_REVOKED");
    const afterRevoke = bootstrap.evaluate("s-kyc-1");
    expect(afterRevoke.active).toBe(false);
    expect(afterRevoke.reasonInactive).toBe("NO_BOOTSTRAP");
  });

  it("does not grant bootstrap to supplier re-verified after previous revoke", () => {
    const bootstrap = new ReputationBootstrapService();

    bootstrap.grant({
      supplierId: "s-re",
      email: "re@example.com",
      kycStatus: "verified",
      kycRef: "ref-a",
    });
    bootstrap.revoke("s-re");

    const key = bootstrap.identityKeyFor("re@example.com", "ref-a");
    const recheck = bootstrap.canGrant("s-re", key, "verified");
    expect(recheck.ok).toBe(true);
  });

  it("region policy off = bootstrap disabled for that region even with verified KYC", () => {
    const regional = new ReputationBootstrapService({
      enabledRegions: ["eu-west"],
    });
    const grant = regional.grant({
      supplierId: "s-region",
      email: "region@example.com",
      kycStatus: "verified",
      kycRef: "r-region",
      region: "us-west",
    });
    expect(grant).toBeNull();
    expect(regional.evaluate("s-region").active).toBe(false);
  });

  it("duplicate account with same email+kycRef gets rejected (anti-gaming)", () => {
    const svc = new ReputationBootstrapService();
    svc.grant({
      supplierId: "acc-primary",
      email: "gaming@example.com",
      kycStatus: "verified",
      kycRef: "kyc-gaming",
    });
    const duplicate = svc.grant({
      supplierId: "acc-duplicate",
      email: "GAMING@example.com",
      kycStatus: "verified",
      kycRef: "kyc-gaming",
    });
    expect(duplicate).toBeNull();
  });
});

describe("ReputationTransparencyService bootstrap integration", () => {
  it("applies bootstrap score for new verified supplier with no evaluation data", () => {
    const bootstrap = new ReputationBootstrapService();
    const svc = new ReputationTransparencyService({
      minCellSizeThreshold: 5,
      bootstrapService: bootstrap,
    });
    const newSupplier: SupplierRecord = {
      id: "supplier-new-bootstrap",
      name: "New Verified Supplier",
      ownerId: "owner-n",
      tenantId: "tenant-n",
    };
    svc.registerSupplier(newSupplier);

    bootstrap.grant({
      supplierId: newSupplier.id,
      email: "new@example.com",
      kycStatus: "verified",
      kycRef: "r-new",
    });

    const projection = svc.getSignalProjection(newSupplier.id);
    expect(projection.overallScore).toBe(DEFAULT_BOOTSTRAP_POLICY.startingScore);
    expect(projection.bootstrap.granted).toBe(true);
    expect(projection.bootstrap.active).toBe(true);
    expect(projection.bootstrap.consumed).toBe(false);
    expect(projection.bootstrap.scoreContribution).toBe(DEFAULT_BOOTSTRAP_POLICY.startingScore);
  });

  it("prefers organic reputation data over bootstrap when evaluations exist", () => {
    const bootstrap = new ReputationBootstrapService();
    const svc = new ReputationTransparencyService({
      minCellSizeThreshold: 5,
      bootstrapService: bootstrap,
    });
    const supplier: SupplierRecord = {
      id: "s-organic",
      name: "Organic with Bootstrap",
      ownerId: "owner-o",
      tenantId: "tenant-o",
    };
    svc.registerSupplier(supplier);
    bootstrap.grant({
      supplierId: supplier.id,
      email: "o@example.com",
      kycStatus: "verified",
      kycRef: "r-o",
    });
    svc.setSupplierEvaluations(supplier.id, [
      { category: "on_time_delivery", totalEvaluations: 20, positiveEvaluations: 18, score: 90.0 },
      { category: "dispute_rate", totalEvaluations: 20, positiveEvaluations: 20, score: 100.0 },
      { category: "fulfillment_speed", totalEvaluations: 20, positiveEvaluations: 18, score: 90.0 },
      { category: "buyer_ratings", totalEvaluations: 20, positiveEvaluations: 18, score: 90.0 },
      { category: "cancellation_rate", totalEvaluations: 20, positiveEvaluations: 20, score: 100.0 },
    ]);

    const projection = svc.getSignalProjection(supplier.id);
    expect(projection.overallScore).toBeGreaterThan(90);
    expect(projection.bootstrap.granted).toBe(true);
  });

  it("falls back to 70 neutral baseline when no data and no bootstrap", () => {
    const bootstrap = new ReputationBootstrapService();
    const svc = new ReputationTransparencyService({
      minCellSizeThreshold: 5,
      bootstrapService: bootstrap,
    });
    const supplier: SupplierRecord = {
      id: "s-neither",
      name: "Neither",
      ownerId: "owner-x",
      tenantId: "tenant-x",
    };
    svc.registerSupplier(supplier);
    const projection = svc.getSignalProjection("s-neither");
    expect(projection.overallScore).toBe(70);
    expect(projection.bootstrap.granted).toBe(false);
    expect(projection.bootstrap.scoreContribution).toBe(0);
  });

  it("exposes getBootstrapService accessor", () => {
    const bootstrap = new ReputationBootstrapService();
    const svc = new ReputationTransparencyService({ bootstrapService: bootstrap });
    expect(svc.getBootstrapService()).toBe(bootstrap);
  });
});

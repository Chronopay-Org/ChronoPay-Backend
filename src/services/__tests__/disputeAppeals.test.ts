/**
 * disputeAppeals.test.ts
 * -----------------------
 * Pure-logic tests for src/services/disputeAppeals.ts. Exercises the
 * state machine, hash chain integrity, panel COI selection, and senior
 * decision validation without any HTTP layer.
 */
import crypto from "node:crypto";

import {
  addSeniorArbiter,
  appendFinalityLink,
  canTransition,
  decideByMajority,
  DEFAULT_APPEAL_WINDOW_MS,
  FINALITY_GENESIS_HASH,
  getSeniorPool,
  isWithinAppealWindow,
  resetSeniorPool,
  selectSeniorPanel,
  SENIOR_PANEL_MIN_SIZE,
  validateSeniorDecision,
  DISPUTE_STATE_TRANSITIONS,
} from "../disputeAppeals.js";
import type {
  Dispute,
  DisputeStatus,
  SeniorArbiter,
  SeniorPanelVote,
} from "../../types/dispute.js";

function buildDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: "dispute-1",
    status: "ADJUDICATED",
    buyerId: "buyer-42",
    supplierId: "supplier-77",
    buyerTenantId: "tenant-buyer",
    supplierTenantId: "tenant-supplier",
    amount: 250,
    evidence: ["receipt.png"],
    ruling: "BUYER_FAVOR",
    arbiter: "arbiter-arbitral-A",
    adjudicatedAt: Date.now(),
    finalityHash: null,
    finalityChain: [],
    ...overrides,
  };
}

describe("canTransition (state machine)", () => {
  it("allows every transition in DISPUTE_STATE_TRANSITIONS", () => {
    for (const [from, allowed] of Object.entries(DISPUTE_STATE_TRANSITIONS)) {
      for (const to of allowed) {
        expect(canTransition(from as DisputeStatus, to)).toBe(true);
      }
    }
  });

  it("rejects transitions not declared in the table", () => {
    expect(canTransition("OPEN", "ADJUDICATED")).toBe(false);
    expect(canTransition("OPEN", "FINAL")).toBe(false);
    expect(canTransition("APPEALED", "FINAL")).toBe(false);
    expect(canTransition("FINAL", "OPEN")).toBe(false);
    expect(canTransition("CLOSED", "APPEALED")).toBe(false);
  });

  it("FINAL, CLOSED, TIMEOUT are terminal", () => {
    expect(DISPUTE_STATE_TRANSITIONS.FINAL).toHaveLength(0);
    expect(DISPUTE_STATE_TRANSITIONS.CLOSED).toHaveLength(0);
    expect(DISPUTE_STATE_TRANSITIONS.TIMEOUT).toHaveLength(0);
  });
});

describe("isWithinAppealWindow", () => {
  it("returns false when adjudicatedAt is missing", () => {
    expect(isWithinAppealWindow(buildDispute({ adjudicatedAt: undefined }), Date.now())).toBe(false);
  });

  it("treats a just-adjudicated dispute as inside the window", () => {
    const now = Date.now();
    const d = buildDispute({ adjudicatedAt: now - 1000 });
    expect(isWithinAppealWindow(d, now)).toBe(true);
  });

  it("returns false once the window elapses", () => {
    const now = Date.now();
    const d = buildDispute({
      adjudicatedAt: now - (DEFAULT_APPEAL_WINDOW_MS + 60_000),
    });
    expect(isWithinAppealWindow(d, now)).toBe(false);
  });

  it("honours a per-dispute appealWindowMs override (shorter)", () => {
    const now = Date.now();
    const d = buildDispute({ adjudicatedAt: now - 5000, appealWindowMs: 1000 });
    expect(isWithinAppealWindow(d, now)).toBe(false);
  });

  it("honours a per-dispute appealWindowMs override (longer)", () => {
    const now = Date.now();
    const d = buildDispute({
      adjudicatedAt: now - (DEFAULT_APPEAL_WINDOW_MS + 60_000),
      appealWindowMs: 30 * 24 * 60 * 60 * 1000,
    });
    expect(isWithinAppealWindow(d, now)).toBe(true);
  });
});

describe("appendFinalityLink (hash chain)", () => {
  it("uses the genesis placeholder when there is no prior hash", () => {
    const d = buildDispute();
    const link = appendFinalityLink(d, "EVIDENCED", { evidenceCount: 1 }, 1_700_000_000_000);
    expect(link.prevHash).toBeNull();
    expect(link.hash).toMatch(/^[a-f0-9]{64}$/);
    // Independently re-derive to verify the formula is documented.
    const raw = `${FINALITY_GENESIS_HASH}|${d.id}|EVIDENCED|${JSON.stringify({ evidenceCount: 1 })}|1700000000000`;
    const expected = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    expect(link.hash).toBe(expected);
  });

  it("chains via prevHash so recomputation matches when the chain is intact", () => {
    const d = buildDispute();
    const l1 = appendFinalityLink(d, "EVIDENCED", { evidenceCount: 1 }, 100);
    d.finalityHash = l1.hash;
    d.finalityChain.push(l1);
    const l2 = appendFinalityLink(d, "ADJUDICATED", { ruling: "BUYER_FAVOR", arbiter: "arbiter-arbitral-A" }, 200);
    d.finalityHash = l2.hash;
    d.finalityChain.push(l2);
    const l3 = appendFinalityLink(d, "APPEALED", { actor: "admin-1" }, 300);
    d.finalityHash = l3.hash;
    d.finalityChain.push(l3);

    expect(l2.prevHash).toBe(l1.hash);
    expect(l3.prevHash).toBe(l2.hash);
    // Final hash differs from intermediate steps.
    expect(l3.hash).not.toBe(l1.hash);
    // Independent recomputation of l3.
    const raw = `${l2.hash}|${d.id}|APPEALED|${JSON.stringify({ actor: "admin-1" })}|300`;
    const expected = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
    expect(l3.hash).toBe(expected);
  });

  it("detects tampering: changing the second link breaks the third", () => {
    const d = buildDispute();
    const l1 = appendFinalityLink(d, "EVIDENCED", { evidenceCount: 1 }, 100);
    d.finalityHash = l1.hash;
    d.finalityChain.push(l1);
    const l2 = appendFinalityLink(d, "ADJUDICATED", { ruling: "BUYER_FAVOR" }, 200);
    d.finalityHash = l2.hash;
    d.finalityChain.push(l2);
    const tamperedHash = crypto.createHash("sha256").update("tampered").digest("hex");
    d.finalityHash = tamperedHash;
    d.finalityChain[1].hash = tamperedHash;
    const l3 = appendFinalityLink(d, "APPEALED", { actor: "admin-1" }, 300);
    // l3 derives from the tampered prev hash, which is now mismatched with
    // a freshly-recomputed predecessor.
    expect(l3.prevHash).toBe(tamperedHash);
    const recomputedL2 = crypto
      .createHash("sha256")
      .update(`${l1.hash}|${d.id}|ADJUDICATED|${JSON.stringify({ ruling: "BUYER_FAVOR" })}|200`, "utf8")
      .digest("hex");
    expect(recomputedL2).not.toBe(tamperedHash);
  });

  it("produces different hashes for identical payloads at different timestamps", () => {
    const d = buildDispute();
    const a = appendFinalityLink(d, "EVIDENCED", { x: 1 }, 100);
    const b = appendFinalityLink(d, "EVIDENCED", { x: 1 }, 200);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("selectSeniorPanel (COI), state isolation", () => {
  beforeEach(() => {
    resetSeniorPool();
  });

  const pool: SeniorArbiter[] = [
    { id: "sa-1", tenantId: "neutral-1" },
    { id: "sa-2", tenantId: "neutral-2" },
    { id: "sa-3", tenantId: "neutral-3" },
    { id: "sa-4", tenantId: "neutral-4" },
    { id: "sa-5", tenantId: "tenant-buyer" }, // COI: buyer
    { id: "sa-6", tenantId: "tenant-supplier" }, // COI: supplier
    { id: "sa-7", tenantId: "neutral-5" },
  ];

  beforeEach(() => {
    pool.forEach(addSeniorArbiter);
  });

  it("selects at least 3 eligible arbiters and includes those with no COI", () => {
    const result = selectSeniorPanel(getSeniorPool(), buildDispute());
    expect(result.panel.length).toBe(SENIOR_PANEL_MIN_SIZE);
    const ids = result.panel.map((p) => p.id);
    expect(ids).toContain("sa-1");
    expect(ids).toContain("sa-2");
    expect(ids).toContain("sa-3");
    // COI exclusions
    expect(result.excluded.map((e) => e.arbiterId).sort()).toEqual(["sa-5", "sa-6"]);
  });

  it("excludes the original arbiter from the senior panel", () => {
    const result = selectSeniorPanel(getSeniorPool(), buildDispute({ arbiter: "sa-2" }));
    expect(result.panel.map((p) => p.id)).not.toContain("sa-2");
    expect(result.excluded.find((e) => e.arbiterId === "sa-2")?.reason).toBe("ORIGINAL_ARBITER");
  });

  it("excludes senior arbiters affiliated with either party's tenant", () => {
    const result = selectSeniorPanel(getSeniorPool(), buildDispute());
    expect(result.panel.map((p) => p.tenantId)).not.toContain("tenant-buyer");
    expect(result.panel.map((p) => p.tenantId)).not.toContain("tenant-supplier");
  });

  it("excludes arbiters who already served on a prior panel (appeal-of-appeal)", () => {
    const d = buildDispute({ panel: [{ id: "sa-1", tenantId: "neutral-1" }] });
    const result = selectSeniorPanel(getSeniorPool(), d);
    expect(result.panel.map((p) => p.id)).not.toContain("sa-1");
    expect(result.excluded.find((e) => e.arbiterId === "sa-1")?.reason).toBe("APPEAL_OF_APPEAL");
  });

  it("returns an alphabetically sorted panel", () => {
    const result = selectSeniorPanel(getSeniorPool(), buildDispute());
    const ids = result.panel.map((p) => p.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("flags an insufficient pool (fewer than 3 distinct candidates after exclusions)", () => {
    resetSeniorPool();
    addSeniorArbiter({ id: "single-1", tenantId: "neutral-x" });
    addSeniorArbiter({ id: "single-2", tenantId: "tenant-buyer" }); // COI
    const result = selectSeniorPanel(getSeniorPool(), buildDispute({ arbiter: "single-1" }));
    expect(result.panel.length).toBeLessThan(SENIOR_PANEL_MIN_SIZE);
  });

  it("reports every excluded arbiter with a reason code (no silent drops)", () => {
    const d = buildDispute({ arbiter: "sa-1", panel: [{ id: "sa-2", tenantId: "neutral-2" }] });
    const result = selectSeniorPanel(getSeniorPool(), d);
    const reasons = Object.fromEntries(result.excluded.map((e) => [e.arbiterId, e.reason]));
    expect(reasons["sa-1"]).toBe("ORIGINAL_ARBITER");
    expect(reasons["sa-5"]).toBe("PARTY_CONFLICT");
    expect(reasons["sa-6"]).toBe("PARTY_CONFLICT");
    expect(reasons["sa-2"]).toBe("APPEAL_OF_APPEAL");
    expect(reasons["sa-7"]).toBeUndefined();
  });
});

describe("validateSeniorDecision", () => {
  const panel: SeniorArbiter[] = [
    { id: "sa-1", tenantId: "neutral-1" },
    { id: "sa-2", tenantId: "neutral-2" },
    { id: "sa-3", tenantId: "neutral-3" },
  ];

  it("rejects when dispute is not in SENIOR_REVIEW", () => {
    const error = validateSeniorDecision(buildDispute({ status: "ADJUDICATED", panel }), { votes: [] });
    expect(error?.code).toBe("INVALID_STATE");
  });

  it("rejects when no panel has been assigned", () => {
    const error = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW" }), { votes: [] });
    expect(error?.code).toBe("PANEL_NOT_SET");
  });

  it("rejects when the vote count does not match panel size", () => {
    const tooFew = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW", panel }), {
      votes: [
        { arbiterId: "sa-1", vote: "UPHOLD", at: 100 },
        { arbiterId: "sa-2", vote: "UPHOLD", at: 101 },
      ],
    });
    expect(tooFew?.code).toBe("INSUFFICIENT_VOTES");

    const tooMany = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW", panel }), {
      votes: [
        { arbiterId: "sa-1", vote: "UPHOLD", at: 100 },
        { arbiterId: "sa-2", vote: "UPHOLD", at: 101 },
        { arbiterId: "sa-3", vote: "UPHOLD", at: 102 },
        { arbiterId: "sa-9", vote: "UPHOLD", at: 103 },
      ],
    });
    expect(tooMany?.code).toBe("INSUFFICIENT_VOTES");
  });

  it("rejects votes from non-panel arbiters", () => {
    const error = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW", panel }), {
      votes: [
        { arbiterId: "sa-1", vote: "UPHOLD", at: 100 },
        { arbiterId: "sa-2", vote: "UPHOLD", at: 101 },
        { arbiterId: "outsider", vote: "UPHOLD", at: 102 },
      ],
    });
    expect(error?.code).toBe("PANEL_VOTE_MISMATCH");
  });

  it("rejects duplicate votes from a panel member", () => {
    const error = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW", panel }), {
      votes: [
        { arbiterId: "sa-1", vote: "UPHOLD", at: 100 },
        { arbiterId: "sa-1", vote: "OVERTURN", at: 101 },
        { arbiterId: "sa-2", vote: "UPHOLD", at: 102 },
      ],
    });
    expect(error?.code).toBe("DUPLICATE_VOTE");
  });

  it("accepts a fresh full-panel vote set", () => {
    const ok = validateSeniorDecision(buildDispute({ status: "SENIOR_REVIEW", panel }), {
      votes: [
        { arbiterId: "sa-1", vote: "UPHOLD", at: 100 },
        { arbiterId: "sa-2", vote: "OVERTURN", at: 101 },
        { arbiterId: "sa-3", vote: "UPHOLD", at: 102 },
      ],
    });
    expect(ok).toBeNull();
  });
});

describe("decideByMajority", () => {
  const at = (n: number): SeniorPanelVote => ({ arbiterId: `voter-${n}`, vote: "UPHOLD", at: 100 + n });

  it("returns UPHOLD when uphold votes are equal or greater", () => {
    expect(
      decideByMajority([at(1), at(2), at(3)]),
    ).toBe("UPHOLD");
    expect(
      decideByMajority([
        { arbiterId: "v1", vote: "UPHOLD", at: 1 },
        { arbiterId: "v2", vote: "UPHOLD", at: 2 },
        { arbiterId: "v3", vote: "OVERTURN", at: 3 },
      ]),
    ).toBe("UPHOLD");
  });

  it("returns OVERTURN when overturn votes exceed upholds", () => {
    expect(
      decideByMajority([
        { arbiterId: "v1", vote: "OVERTURN", at: 1 },
        { arbiterId: "v2", vote: "OVERTURN", at: 2 },
        { arbiterId: "v3", vote: "UPHOLD", at: 3 },
      ]),
    ).toBe("OVERTURN");
  });
});

// Restore spy state to avoid leaking across suites. Without this, other
// tests in this file (if added later) would observe a populated pool.
afterEach(() => {
  resetSeniorPool();
});

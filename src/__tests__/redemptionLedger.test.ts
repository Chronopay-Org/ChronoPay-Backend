import { jest } from "@jest/globals";
import {
  InMemoryRedemptionLedger,
  DuplicateRedemptionError,
  deriveEntryHash,
  verifyChain,
} from "../services/redemptionLedger.js";
import { walkChain, runVerifier } from "../scripts/verify-redemption-chain.js";

// ─── Fixtures / helpers ───────────────────────────────────────────────────────

function baseInput(overrides: Partial<{
  redemption_id: string;
  token_id: string;
  redeemer_id: string;
}> = {}) {
  return {
    redemption_id: overrides.redemption_id ?? "rdm-1",
    token_id: overrides.token_id ?? "tok-abc",
    redeemer_id: overrides.redeemer_id ?? "user-xyz",
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("InMemoryRedemptionLedger", () => {
  let ledger: InMemoryRedemptionLedger;

  beforeEach(() => {
    ledger = new InMemoryRedemptionLedger();
  });

  // ── Basic insert ──────────────────────────────────────────────────────────

  it("inserts the first entry as the genesis row (prev_hash = '')", async () => {
    const entry = await ledger.insert(baseInput());

    expect(entry.prev_hash).toBe("");
    expect(entry.redemption_id).toBe("rdm-1");
    expect(ledger.size()).toBe(1);
  });

  it("links each subsequent entry to its predecessor", async () => {
    const e1 = await ledger.insert(baseInput({ redemption_id: "rdm-1" }));
    const e2 = await ledger.insert(baseInput({ redemption_id: "rdm-2" }));
    const e3 = await ledger.insert(baseInput({ redemption_id: "rdm-3" }));

    expect(e1.prev_hash).toBe("");
    expect(e2.prev_hash).toBe(e1.entry_hash);
    expect(e3.prev_hash).toBe(e2.entry_hash);
  });

  it("stores the correct entry_hash (SHA-256 of id|prevHash|createdAt)", async () => {
    const fixedDate = new Date("2025-01-01T00:00:00.000Z");
    const entry = await ledger.insert(baseInput(), () => fixedDate);

    const expected = deriveEntryHash("rdm-1", "", fixedDate);
    expect(entry.entry_hash).toBe(expected);
  });

  it("persists metadata when provided", async () => {
    const entry = await ledger.insert({
      ...baseInput(),
      metadata: { note: "promo" },
    });
    expect(entry.metadata).toEqual({ note: "promo" });
  });

  it("findByRedemptionId returns the correct entry", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-1" }));
    await ledger.insert(baseInput({ redemption_id: "rdm-2" }));

    expect(ledger.findByRedemptionId("rdm-1")?.redemption_id).toBe("rdm-1");
    expect(ledger.findByRedemptionId("rdm-2")?.redemption_id).toBe("rdm-2");
    expect(ledger.findByRedemptionId("rdm-99")).toBeUndefined();
  });

  // ── Exactly-once / idempotency ─────────────────────────────────────────────

  it("rejects a duplicate redemption_id with DuplicateRedemptionError", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-dup" }));

    await expect(
      ledger.insert(baseInput({ redemption_id: "rdm-dup" })),
    ).rejects.toThrow(DuplicateRedemptionError);
  });

  it("includes the redemption_id in the DuplicateRedemptionError", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-err" }));

    const err = await ledger
      .insert(baseInput({ redemption_id: "rdm-err" }))
      .catch((e) => e);

    expect(err).toBeInstanceOf(DuplicateRedemptionError);
    expect((err as DuplicateRedemptionError).redemptionId).toBe("rdm-err");
  });

  it("does not grow the chain when a duplicate is rejected", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-1" }));

    try {
      await ledger.insert(baseInput({ redemption_id: "rdm-1" }));
    } catch {
      // expected
    }

    expect(ledger.size()).toBe(1);
  });

  it("allows different redemption IDs for the same token/redeemer pair", async () => {
    await ledger.insert({ redemption_id: "rdm-A", token_id: "tok-1", redeemer_id: "usr-1" });
    await expect(
      ledger.insert({ redemption_id: "rdm-B", token_id: "tok-1", redeemer_id: "usr-1" }),
    ).resolves.toBeDefined();
    expect(ledger.size()).toBe(2);
  });

  // ── Concurrent claim ──────────────────────────────────────────────────────

  it("serialises concurrent inserts: exactly one succeeds, one is rejected as duplicate", async () => {
    const id = "rdm-concurrent";
    const [r1, r2] = await Promise.allSettled([
      ledger.insert(baseInput({ redemption_id: id })),
      ledger.insert(baseInput({ redemption_id: id })),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(ledger.size()).toBe(1);
  });

  it("maintains a valid chain after multiple concurrent independent inserts", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `rdm-c${i}`);
    await Promise.all(
      ids.map((rid) => ledger.insert(baseInput({ redemption_id: rid }))),
    );

    expect(ledger.size()).toBe(10);
    const result = verifyChain(ledger);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(10);
  });

  it("maintains correct prev_hash links under concurrent load", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `rdm-cl${i}`);
    await Promise.all(
      ids.map((rid) => ledger.insert(baseInput({ redemption_id: rid }))),
    );

    const all = ledger.listAll();
    expect(all[0].prev_hash).toBe("");
    for (let i = 1; i < all.length; i++) {
      expect(all[i].prev_hash).toBe(all[i - 1].entry_hash);
    }
  });

  it("rejects all concurrent duplicates when many fire simultaneously", async () => {
    const id = "rdm-storm";
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ledger.insert(baseInput({ redemption_id: id })),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expect(ledger.size()).toBe(1);
  });

  // ── verifyChain — valid chain ─────────────────────────────────────────────

  it("reports valid for an empty ledger", () => {
    expect(verifyChain(ledger)).toEqual({ valid: true, entriesChecked: 0 });
  });

  it("reports valid for a single-entry ledger", async () => {
    await ledger.insert(baseInput());
    const result = verifyChain(ledger);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(1);
  });

  it("reports valid after a linear sequence of inserts", async () => {
    for (let i = 0; i < 5; i++) {
      await ledger.insert(baseInput({ redemption_id: `rdm-v${i}` }));
    }
    const result = verifyChain(ledger);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(5);
  });

  // ── Malicious rewrite detection ───────────────────────────────────────────

  it("detects a tampered entry_hash in the genesis row", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-t1" }));
    await ledger.insert(baseInput({ redemption_id: "rdm-t2" }));

    ledger._tamperEntryHash("rdm-t1", "deadbeef");

    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
    expect(result.error).toMatch(/invalid hash/i);
  });

  it("detects a tampered entry_hash in the middle of the chain", async () => {
    for (let i = 0; i < 4; i++) {
      await ledger.insert(baseInput({ redemption_id: `rdm-m${i}` }));
    }

    ledger._tamperEntryHash("rdm-m1", "c0ffee");

    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
    // index 1 has bad hash — first broken index must be <= 1
    expect(result.firstBrokenIndex).toBeLessThanOrEqual(1);
  });

  it("detects a retroactively modified redemption_id field", async () => {
    const fixedDate = new Date("2025-06-01T00:00:00.000Z");
    await ledger.insert(baseInput({ redemption_id: "rdm-orig" }), () => fixedDate);

    // Directly mutate the redemption_id on the entry stored in the chain
    const entry = ledger.listAll()[0] as { redemption_id: string };
    entry.redemption_id = "rdm-hacked";

    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
  });

  it("detects a tampered created_at field", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-ts" }));

    const entry = ledger.listAll()[0] as { created_at: Date };
    entry.created_at = new Date("2001-01-01T00:00:00.000Z"); // changed

    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
  });

  // ── Chain skip detection ──────────────────────────────────────────────────

  it("detects a missing entry in the middle of the chain", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-s1" }));
    await ledger.insert(baseInput({ redemption_id: "rdm-s2" }));
    await ledger.insert(baseInput({ redemption_id: "rdm-s3" }));

    // Simulate a direct DB DELETE that bypasses the application layer
    ledger._deleteEntry("rdm-s2");

    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
  });

  it("detects a skipped genesis row", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-g1" }));
    await ledger.insert(baseInput({ redemption_id: "rdm-g2" }));

    ledger._deleteEntry("rdm-g1");

    // rdm-g2 now sits at index 0 with a non-empty prev_hash
    const result = verifyChain(ledger);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it("clear() resets the ledger so new inserts start fresh", async () => {
    await ledger.insert(baseInput({ redemption_id: "rdm-pre" }));
    ledger.clear();

    expect(ledger.size()).toBe(0);

    const entry = await ledger.insert(baseInput({ redemption_id: "rdm-pre" }));
    expect(entry.prev_hash).toBe(""); // genesis again
  });
});

// ─── walkChain (CLI verifier) ─────────────────────────────────────────────────

describe("walkChain (verify-redemption-chain script)", () => {
  it("returns valid for an empty row set", () => {
    expect(walkChain([])).toEqual({ valid: true, entriesChecked: 0 });
  });

  it("returns valid for a correctly-chained row set", () => {
    const t1 = new Date("2025-01-01T00:00:00.000Z");
    const h1 = deriveEntryHash("rdm-1", "", t1);
    const t2 = new Date("2025-01-02T00:00:00.000Z");
    const h2 = deriveEntryHash("rdm-2", h1, t2);

    const rows = [
      { redemption_id: "rdm-1", entry_hash: h1, prev_hash: "", created_at: t1 },
      { redemption_id: "rdm-2", entry_hash: h2, prev_hash: h1, created_at: t2 },
    ];

    const result = walkChain(rows);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(2);
  });

  it("detects a tampered entry_hash in the supplied rows", () => {
    const t1 = new Date("2025-01-01T00:00:00.000Z");
    const rows = [
      { redemption_id: "rdm-1", entry_hash: "bad-hash", prev_hash: "", created_at: t1 },
    ];

    const result = walkChain(rows);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
    expect(result.error).toMatch(/mismatch|invalid hash/i);
  });

  it("detects a broken prev_hash link between two rows", () => {
    const t1 = new Date("2025-01-01T00:00:00.000Z");
    const h1 = deriveEntryHash("rdm-1", "", t1);
    const t2 = new Date("2025-01-02T00:00:00.000Z");
    // Use wrong prev for row 2 so its own hash is internally consistent
    // but the link to row 1 is broken
    const h2 = deriveEntryHash("rdm-2", "wrong-prev", t2);

    const rows = [
      { redemption_id: "rdm-1", entry_hash: h1, prev_hash: "", created_at: t1 },
      { redemption_id: "rdm-2", entry_hash: h2, prev_hash: "wrong-prev", created_at: t2 },
    ];

    const result = walkChain(rows);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(1);
    expect(result.error).toMatch(/prev_hash/i);
  });

  it("flags a non-empty prev_hash on the genesis row", () => {
    const t1 = new Date("2025-01-01T00:00:00.000Z");
    const h1 = deriveEntryHash("rdm-1", "some-prev", t1);
    const rows = [
      { redemption_id: "rdm-1", entry_hash: h1, prev_hash: "some-prev", created_at: t1 },
    ];

    const result = walkChain(rows);
    expect(result.valid).toBe(false);
    expect(result.firstBrokenIndex).toBe(0);
    expect(result.error).toMatch(/genesis/i);
  });

  it("accepts ISO string created_at as well as Date objects", () => {
    const isoStr = "2025-03-15T12:00:00.000Z";
    const t1 = new Date(isoStr);
    const h1 = deriveEntryHash("rdm-iso", "", t1);

    const rows = [
      { redemption_id: "rdm-iso", entry_hash: h1, prev_hash: "", created_at: isoStr },
    ];

    expect(walkChain(rows).valid).toBe(true);
  });
});

// ─── runVerifier (programmatic use without DB) ────────────────────────────────

describe("runVerifier", () => {
  let consoleSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("returns valid:true for a well-formed chain", async () => {
    const t1 = new Date("2025-03-01T00:00:00.000Z");
    const h1 = deriveEntryHash("r1", "", t1);
    const report = await runVerifier([
      { redemption_id: "r1", entry_hash: h1, prev_hash: "", created_at: t1 },
    ]);
    expect(report.valid).toBe(true);
    expect(report.entriesChecked).toBe(1);
  });

  it("returns valid:false for a tampered chain", async () => {
    const t1 = new Date("2025-03-01T00:00:00.000Z");
    const report = await runVerifier([
      { redemption_id: "r1", entry_hash: "tampered", prev_hash: "", created_at: t1 },
    ]);
    expect(report.valid).toBe(false);
  });

  it("logs a success message for a valid chain", async () => {
    const t1 = new Date("2025-03-01T00:00:00.000Z");
    const h1 = deriveEntryHash("r1", "", t1);
    await runVerifier([
      { redemption_id: "r1", entry_hash: h1, prev_hash: "", created_at: t1 },
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("intact"));
  });

  it("logs an error message for a broken chain", async () => {
    const t1 = new Date("2025-03-01T00:00:00.000Z");
    await runVerifier([
      { redemption_id: "r1", entry_hash: "bad", prev_hash: "", created_at: t1 },
    ]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("integrity violation"),
    );
  });

  it("prints a verbose header and entry details when verbose=true", async () => {
    const t1 = new Date("2025-03-01T00:00:00.000Z");
    const h1 = deriveEntryHash("r1", "", t1);
    await runVerifier(
      [{ redemption_id: "r1", entry_hash: h1, prev_hash: "", created_at: t1 }],
      true,
    );

    const calls = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((l) => l.includes("Verifying"))).toBe(true);
    expect(calls.some((l) => l.includes("r1"))).toBe(true);
  });

  it("returns valid:true and logs '0 entries' for an empty row set", async () => {
    const report = await runVerifier([]);
    expect(report.valid).toBe(true);
    expect(report.entriesChecked).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("0 entries"));
  });
});

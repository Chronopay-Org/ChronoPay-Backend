/**
 * sorobanEscrowClient.test.ts
 *
 * Tests for the Soroban escrow contract integration layer.
 * Issue #438 – Integrate Stellar Soroban escrow contract for slot custody
 * with two-phase settle.
 */

import {
  SorobanEscrowClient,
  ContractHashMismatchError,
  EscrowDuplicateHoldError,
  EscrowHoldNotFoundError,
  type IContractHashVerifier,
  type EscrowHoldParams,
} from "../../clients/sorobanEscrowClient.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PINNED_HASH = "a".repeat(64);
const VALID_CONTRACT_ADDRESS = "C" + "A".repeat(55);

const BASE_HOLD: EscrowHoldParams = {
  bookingIntentId: "intent-001",
  slotId: "slot-001",
  amountStroops: 100_000_000, // 10 XLM
  buyerAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
};

// ─── Fake hash verifier ───────────────────────────────────────────────────────

function makeVerifier(liveHash: string): IContractHashVerifier {
  return {
    getLiveWasmHash: async () => liveHash,
  };
}

function makeClient(
  liveHash = PINNED_HASH,
  now = "2026-07-28T00:00:00.000Z",
): SorobanEscrowClient {
  return new SorobanEscrowClient(
    VALID_CONTRACT_ADDRESS,
    PINNED_HASH,
    makeVerifier(liveHash),
    () => now,
  );
}

// ─── Contract hash pinning ────────────────────────────────────────────────────

describe("SorobanEscrowClient – contract hash pinning", () => {
  it("hold() succeeds when live hash matches pinned hash", async () => {
    const client = makeClient(PINNED_HASH);
    await expect(client.hold(BASE_HOLD)).resolves.toMatchObject({ phase: "hold" });
  });

  it("hold() throws ContractHashMismatchError when live hash differs", async () => {
    const client = makeClient("b".repeat(64));
    await expect(client.hold(BASE_HOLD)).rejects.toThrow(ContractHashMismatchError);
  });

  it("release() throws ContractHashMismatchError when live hash differs", async () => {
    // Establish a hold with a good hash first
    const clientA = makeClient(PINNED_HASH);
    await clientA.hold(BASE_HOLD);

    // Now swap the verifier to return a bad hash on the second call
    const clientB = new SorobanEscrowClient(
      VALID_CONTRACT_ADDRESS,
      PINNED_HASH,
      makeVerifier("c".repeat(64)),
    );
    await expect(
      clientB.release({ bookingIntentId: BASE_HOLD.bookingIntentId }),
    ).rejects.toThrow(ContractHashMismatchError);
  });

  it("refund() throws ContractHashMismatchError when live hash differs", async () => {
    const client = makeClient("d".repeat(64));
    await expect(
      client.refund({ bookingIntentId: BASE_HOLD.bookingIntentId }),
    ).rejects.toThrow(ContractHashMismatchError);
  });

  it("ContractHashMismatchError carries pinned and live hashes", async () => {
    const live = "b".repeat(64);
    const client = makeClient(live);
    try {
      await client.hold(BASE_HOLD);
      fail("Expected ContractHashMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractHashMismatchError);
      const mismatch = err as ContractHashMismatchError;
      expect(mismatch.pinned).toBe(PINNED_HASH);
      expect(mismatch.live).toBe(live);
    }
  });

  it("accepts upper-case pinned hash and normalises before comparison", async () => {
    const upperPinned = PINNED_HASH.toUpperCase();
    const client = new SorobanEscrowClient(
      VALID_CONTRACT_ADDRESS,
      upperPinned,
      makeVerifier(PINNED_HASH), // live is lower-case
    );
    await expect(client.hold(BASE_HOLD)).resolves.toMatchObject({ phase: "hold" });
  });
});

// ─── Phase 1: hold ────────────────────────────────────────────────────────────

describe("SorobanEscrowClient – hold()", () => {
  it("returns a result with phase 'hold' and a non-empty txHash", async () => {
    const client = makeClient();
    const result = await client.hold(BASE_HOLD);
    expect(result.phase).toBe("hold");
    expect(result.txHash).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(result.txHash)).toBe(true);
  });

  it("stores the hold record accessible via getHold()", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record).toBeDefined();
    expect(record!.slotId).toBe(BASE_HOLD.slotId);
    expect(record!.amountStroops).toBe(BASE_HOLD.amountStroops);
    expect(record!.buyerAddress).toBe(BASE_HOLD.buyerAddress);
    expect(record!.settledAt).toBeUndefined();
  });

  it("stamps the hold record with the mocked heldAt timestamp", async () => {
    const now = "2026-07-28T12:00:00.000Z";
    const client = makeClient(PINNED_HASH, now);
    await client.hold(BASE_HOLD);
    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record!.heldAt).toBe(now);
  });

  it("throws EscrowDuplicateHoldError on second hold for same bookingIntentId", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    await expect(client.hold(BASE_HOLD)).rejects.toThrow(EscrowDuplicateHoldError);
  });

  it("allows holds for different booking intents independently", async () => {
    const client = makeClient();
    await client.hold({ ...BASE_HOLD, bookingIntentId: "intent-A" });
    await client.hold({ ...BASE_HOLD, bookingIntentId: "intent-B" });
    expect(client.listHolds()).toHaveLength(2);
  });

  it("is deterministic: same bookingIntentId always produces the same txHash", async () => {
    const clientA = makeClient();
    const resultA = await clientA.hold(BASE_HOLD);

    const clientB = makeClient();
    // First hold on clientB must succeed (fresh store)
    const resultB = await clientB.hold(BASE_HOLD);

    expect(resultA.txHash).toBe(resultB.txHash);
  });
});

// ─── Phase 2a: release ────────────────────────────────────────────────────────

describe("SorobanEscrowClient – release()", () => {
  it("returns a result with phase 'release'", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    const result = await client.release({ bookingIntentId: BASE_HOLD.bookingIntentId });
    expect(result.phase).toBe("release");
  });

  it("stamps the hold record with settledAt and settlePhase 'release'", async () => {
    const now = "2026-07-28T13:00:00.000Z";
    const client = makeClient(PINNED_HASH, now);
    await client.hold(BASE_HOLD);
    await client.release({ bookingIntentId: BASE_HOLD.bookingIntentId });
    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record!.settledAt).toBe(now);
    expect(record!.settlePhase).toBe("release");
  });

  it("produces a different txHash from the hold operation", async () => {
    const client = makeClient();
    const holdResult = await client.hold(BASE_HOLD);
    const releaseResult = await client.release({ bookingIntentId: BASE_HOLD.bookingIntentId });
    expect(holdResult.txHash).not.toBe(releaseResult.txHash);
  });

  it("throws EscrowHoldNotFoundError when no hold exists", async () => {
    const client = makeClient();
    await expect(
      client.release({ bookingIntentId: "nonexistent" }),
    ).rejects.toThrow(EscrowHoldNotFoundError);
  });

  it("EscrowHoldNotFoundError carries the bookingIntentId", async () => {
    const client = makeClient();
    try {
      await client.release({ bookingIntentId: "ghost-intent" });
      fail("Expected EscrowHoldNotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(EscrowHoldNotFoundError);
      expect((err as EscrowHoldNotFoundError).bookingIntentId).toBe("ghost-intent");
    }
  });
});

// ─── Phase 2b: refund ─────────────────────────────────────────────────────────

describe("SorobanEscrowClient – refund()", () => {
  it("returns a result with phase 'refund'", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    const result = await client.refund({ bookingIntentId: BASE_HOLD.bookingIntentId });
    expect(result.phase).toBe("refund");
  });

  it("stamps the hold record with settledAt and settlePhase 'refund'", async () => {
    const now = "2026-07-28T14:00:00.000Z";
    const client = makeClient(PINNED_HASH, now);
    await client.hold(BASE_HOLD);
    await client.refund({ bookingIntentId: BASE_HOLD.bookingIntentId });
    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record!.settledAt).toBe(now);
    expect(record!.settlePhase).toBe("refund");
  });

  it("throws EscrowHoldNotFoundError when no hold exists", async () => {
    const client = makeClient();
    await expect(
      client.refund({ bookingIntentId: "nonexistent" }),
    ).rejects.toThrow(EscrowHoldNotFoundError);
  });

  it("produces a different txHash from the hold and release operations", async () => {
    const client = makeClient();
    const holdResult = await client.hold(BASE_HOLD);
    const refundResult = await client.refund({ bookingIntentId: BASE_HOLD.bookingIntentId });
    expect(holdResult.txHash).not.toBe(refundResult.txHash);
  });
});

// ─── Two-phase lifecycle (integration) ───────────────────────────────────────

describe("SorobanEscrowClient – two-phase lifecycle", () => {
  it("full happy path: hold then release", async () => {
    const client = makeClient();
    const holdResult = await client.hold(BASE_HOLD);
    const releaseResult = await client.release({
      bookingIntentId: BASE_HOLD.bookingIntentId,
    });

    expect(holdResult.phase).toBe("hold");
    expect(releaseResult.phase).toBe("release");

    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record!.settlePhase).toBe("release");
    expect(record!.settledAt).toBeDefined();
  });

  it("full dispute path: hold then refund", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    const refundResult = await client.refund({
      bookingIntentId: BASE_HOLD.bookingIntentId,
    });

    expect(refundResult.phase).toBe("refund");
    const record = client.getHold(BASE_HOLD.bookingIntentId);
    expect(record!.settlePhase).toBe("refund");
  });

  it("cannot hold for the same intent after it has been settled", async () => {
    const client = makeClient();
    await client.hold(BASE_HOLD);
    await client.release({ bookingIntentId: BASE_HOLD.bookingIntentId });
    // Hold record still exists (already settled), so duplicate hold throws
    await expect(client.hold(BASE_HOLD)).rejects.toThrow(EscrowDuplicateHoldError);
  });

  it("listHolds() returns all records including settled ones", async () => {
    const client = makeClient();
    await client.hold({ ...BASE_HOLD, bookingIntentId: "intent-1" });
    await client.hold({ ...BASE_HOLD, bookingIntentId: "intent-2" });
    await client.release({ bookingIntentId: "intent-1" });

    const holds = client.listHolds();
    expect(holds).toHaveLength(2);
    const settled = holds.find((h) => h.bookingIntentId === "intent-1");
    const open = holds.find((h) => h.bookingIntentId === "intent-2");
    expect(settled!.settlePhase).toBe("release");
    expect(open!.settledAt).toBeUndefined();
  });
});

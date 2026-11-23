import {
  EscrowHoldingsService,
  EscrowHoldNotFoundError,
  EscrowHoldAlreadyResolvedError,
  type CreateEscrowHoldInput,
} from "../escrowHoldingsService.js";

describe("EscrowHoldingsService", () => {
  const baseInput: CreateEscrowHoldInput = {
    bookingIntentId: "intent-101",
    amountCents: 2500,
    currency: "USD",
    supplierId: "supplier-45",
    buyerId: "buyer-12",
    slotEndTimeMs: 1_700_000_000_000,
    confirmationWindowMs: 3_600_000,
  };

  it("creates a held balance and releases it after the confirmation window", async () => {
    const service = new EscrowHoldingsService({ now: () => 1_700_000_000_000 });

    const created = await service.createHold(baseInput, "ops-1");

    expect(created.state).toBe("held");
    expect(created.scheduledReleaseAtMs).toBe(1_700_000_000_000 + 3_600_000);

    const released = await service.processDueHolds(1_700_000_000_000 + 3_600_001, "worker-2");
    expect(released).toHaveLength(1);
    expect(released[0].state).toBe("released");
    expect(released[0].auditTrail.at(-1)?.action).toBe("released");
  });

  it("rejects invalid amounts, duplicate booking intent IDs, and empty actors", async () => {
    const service = new EscrowHoldingsService();

    await expect(
      service.createHold({ ...baseInput, amountCents: 0 }, "ops-1"),
    ).rejects.toThrow("amountCents must be a positive integer");

    await expect(
      service.createHold(baseInput, ""),
    ).rejects.toThrow("actorId is required");

    await service.createHold(baseInput, "ops-1");
    await expect(service.createHold(baseInput, "ops-2")).rejects.toThrow(
      "already has an escrow hold",
    );
  });

  it("refunds a hold on cancellation and refuses duplicate resolution", async () => {
    const service = new EscrowHoldingsService({ now: () => 1_700_000_000_000 });
    const hold = await service.createHold(baseInput, "ops-1");

    const refunded = await service.refundHold(hold.id, "buyer-12", "customer_cancelled");
    expect(refunded.state).toBe("refunded");

    await expect(
      service.releaseHold(hold.id, "worker-2"),
    ).rejects.toThrow(EscrowHoldAlreadyResolvedError);
  });

  it("marks disputed holds and does not auto-release them until resolved", async () => {
    const service = new EscrowHoldingsService({ now: () => 1_700_000_000_000 });
    const hold = await service.createHold(baseInput, "ops-1");

    const disputed = await service.disputeHold(hold.id, "supplier-45", "delivery dispute");
    expect(disputed.state).toBe("disputed");

    const due = await service.processDueHolds(1_700_000_000_000 + 3_600_001, "worker-2");
    expect(due).toHaveLength(0);
  });

  it("resolves concurrent release requests deterministically", async () => {
    const service = new EscrowHoldingsService({ now: () => 1_700_000_000_000 });
    const hold = await service.createHold(baseInput, "ops-1");

    const [first, second] = await Promise.allSettled([
      service.releaseHold(hold.id, "worker-1"),
      service.releaseHold(hold.id, "worker-2"),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(EscrowHoldAlreadyResolvedError);
  });

  it("throws a clear error for unknown holds", async () => {
    const service = new EscrowHoldingsService();

    await expect(service.releaseHold("missing", "worker-1")).rejects.toThrow(EscrowHoldNotFoundError);
  });
});

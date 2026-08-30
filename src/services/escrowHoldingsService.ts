export type EscrowHoldState = "held" | "released" | "refunded" | "disputed";

export interface EscrowHoldAuditEntry {
  action: "created" | "released" | "refunded" | "disputed";
  actorId: string;
  atMs: number;
  reason?: string;
  state: EscrowHoldState;
}

export interface EscrowHoldRecord {
  id: string;
  bookingIntentId: string;
  buyerId: string;
  supplierId: string;
  amountCents: number;
  currency: string;
  slotEndTimeMs: number;
  confirmationWindowMs: number;
  scheduledReleaseAtMs: number;
  state: EscrowHoldState;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs?: number;
  lastReason?: string;
  disputeReason?: string;
  auditTrail: EscrowHoldAuditEntry[];
}

export interface CreateEscrowHoldInput {
  bookingIntentId: string;
  amountCents: number;
  currency: string;
  supplierId: string;
  buyerId: string;
  slotEndTimeMs: number;
  confirmationWindowMs: number;
}

export class EscrowHoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`Escrow hold not found: ${holdId}`);
    this.name = "EscrowHoldNotFoundError";
  }
}

export class EscrowHoldAlreadyResolvedError extends Error {
  constructor(holdId: string, state: EscrowHoldState) {
    super(`Escrow hold ${holdId} is already resolved with state "${state}".`);
    this.name = "EscrowHoldAlreadyResolvedError";
  }
}

export class EscrowHoldInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowHoldInvalidInputError";
  }
}

export interface EscrowHoldingsServiceOptions {
  now?: () => number;
}

export class EscrowHoldingsService {
  private readonly holds = new Map<string, EscrowHoldRecord>();
  private readonly bookingIntentIndex = new Map<string, string>();
  private readonly nowFn: () => number;

  constructor(options: EscrowHoldingsServiceOptions = {}) {
    this.nowFn = options.now ?? (() => Date.now());
  }

  async createHold(
    input: CreateEscrowHoldInput,
    actorId: string,
  ): Promise<EscrowHoldRecord> {
    this.validateActor(actorId);
    this.validateCreateInput(input);

    if (this.bookingIntentIndex.has(input.bookingIntentId)) {
      throw new EscrowHoldInvalidInputError(
        `Booking intent ${input.bookingIntentId} already has an escrow hold.`,
      );
    }

    const now = this.nowFn();
    const hold: EscrowHoldRecord = {
      id: `hold-${cryptoRandomId()}`,
      bookingIntentId: input.bookingIntentId,
      buyerId: input.buyerId,
      supplierId: input.supplierId,
      amountCents: input.amountCents,
      currency: input.currency.trim(),
      slotEndTimeMs: input.slotEndTimeMs,
      confirmationWindowMs: input.confirmationWindowMs,
      scheduledReleaseAtMs: input.slotEndTimeMs + input.confirmationWindowMs,
      state: "held",
      createdAtMs: now,
      updatedAtMs: now,
      lastReason: "escrow_held",
      auditTrail: [
        {
          action: "created",
          actorId,
          atMs: now,
          reason: "escrow_held",
          state: "held",
        },
      ],
    };

    this.holds.set(hold.id, { ...hold, auditTrail: [...hold.auditTrail] });
    this.bookingIntentIndex.set(input.bookingIntentId, hold.id);

    return this.cloneHold(hold);
  }

  async releaseHold(
    holdId: string,
    actorId: string,
    reason = "slot_delivery_confirmed",
  ): Promise<EscrowHoldRecord> {
    const hold = this.requireHold(holdId);

    if (hold.state !== "held") {
      throw new EscrowHoldAlreadyResolvedError(holdId, hold.state);
    }

    this.validateActor(actorId);
    const now = this.nowFn();
    const updated: EscrowHoldRecord = {
      ...hold,
      state: "released",
      updatedAtMs: now,
      resolvedAtMs: now,
      lastReason: reason,
      auditTrail: [
        ...hold.auditTrail,
        {
          action: "released",
          actorId,
          atMs: now,
          reason,
          state: "released",
        },
      ],
    };

    this.holds.set(holdId, updated);
    this.bookingIntentIndex.delete(hold.bookingIntentId);
    return this.cloneHold(updated);
  }

  async refundHold(
    holdId: string,
    actorId: string,
    reason = "booking_cancelled",
  ): Promise<EscrowHoldRecord> {
    const hold = this.requireHold(holdId);

    if (hold.state !== "held" && hold.state !== "disputed") {
      throw new EscrowHoldAlreadyResolvedError(holdId, hold.state);
    }

    this.validateActor(actorId);
    const now = this.nowFn();
    const updated: EscrowHoldRecord = {
      ...hold,
      state: "refunded",
      updatedAtMs: now,
      resolvedAtMs: now,
      lastReason: reason,
      auditTrail: [
        ...hold.auditTrail,
        {
          action: "refunded",
          actorId,
          atMs: now,
          reason,
          state: "refunded",
        },
      ],
    };

    this.holds.set(holdId, updated);
    this.bookingIntentIndex.delete(hold.bookingIntentId);
    return this.cloneHold(updated);
  }

  async disputeHold(
    holdId: string,
    actorId: string,
    reason = "delivery_dispute",
  ): Promise<EscrowHoldRecord> {
    const hold = this.requireHold(holdId);

    if (hold.state !== "held") {
      throw new EscrowHoldAlreadyResolvedError(holdId, hold.state);
    }

    this.validateActor(actorId);
    const now = this.nowFn();
    const updated: EscrowHoldRecord = {
      ...hold,
      state: "disputed",
      updatedAtMs: now,
      lastReason: reason,
      disputeReason: reason,
      auditTrail: [
        ...hold.auditTrail,
        {
          action: "disputed",
          actorId,
          atMs: now,
          reason,
          state: "disputed",
        },
      ],
    };

    this.holds.set(holdId, updated);
    return this.cloneHold(updated);
  }

  async processDueHolds(nowMs = this.nowFn(), actorId = "system"): Promise<EscrowHoldRecord[]> {
    const due = [...this.holds.values()].filter(
      (hold) => hold.state === "held" && hold.scheduledReleaseAtMs <= nowMs,
    );

    const resolved: EscrowHoldRecord[] = [];
    for (const hold of due) {
      const released = await this.releaseHold(hold.id, actorId, "scheduled_release_after_confirmation_window");
      resolved.push(released);
    }
    return resolved;
  }

  getHold(holdId: string): EscrowHoldRecord | undefined {
    const hold = this.holds.get(holdId);
    return hold ? this.cloneHold(hold) : undefined;
  }

  getHoldByBookingIntent(bookingIntentId: string): EscrowHoldRecord | undefined {
    const holdId = this.bookingIntentIndex.get(bookingIntentId);
    if (!holdId) return undefined;
    return this.getHold(holdId);
  }

  private validateCreateInput(input: CreateEscrowHoldInput): void {
    if (!input.bookingIntentId || !input.bookingIntentId.trim()) {
      throw new EscrowHoldInvalidInputError("bookingIntentId is required");
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new EscrowHoldInvalidInputError("amountCents must be a positive integer");
    }
    if (!input.currency || !input.currency.trim()) {
      throw new EscrowHoldInvalidInputError("currency is required");
    }
    if (!input.supplierId || !input.supplierId.trim()) {
      throw new EscrowHoldInvalidInputError("supplierId is required");
    }
    if (!input.buyerId || !input.buyerId.trim()) {
      throw new EscrowHoldInvalidInputError("buyerId is required");
    }
    if (!Number.isInteger(input.slotEndTimeMs) || input.slotEndTimeMs < 0) {
      throw new EscrowHoldInvalidInputError("slotEndTimeMs must be a non-negative integer");
    }
    if (!Number.isInteger(input.confirmationWindowMs) || input.confirmationWindowMs < 0) {
      throw new EscrowHoldInvalidInputError(
        "confirmationWindowMs must be a non-negative integer",
      );
    }
  }

  private validateActor(actorId: string): void {
    if (typeof actorId !== "string" || !actorId.trim()) {
      throw new EscrowHoldInvalidInputError("actorId is required");
    }
  }

  private requireHold(holdId: string): EscrowHoldRecord {
    const hold = this.holds.get(holdId);
    if (!hold) {
      throw new EscrowHoldNotFoundError(holdId);
    }
    return hold;
  }

  private cloneHold(hold: EscrowHoldRecord): EscrowHoldRecord {
    return { ...hold, auditTrail: [...hold.auditTrail] };
  }
}

function cryptoRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 12; i += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}

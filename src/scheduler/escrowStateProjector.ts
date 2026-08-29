/**
 * Escrow State Projector
 * ----------------------
 *
 * Applies an `EscrowEvent` to local booking intent + slot state. The projector
 * is pure: it has no I/O outside of the repositories it is given. It is also
 * idempotent — re-projecting the same event yields a `noop_*` outcome and
 * leaves state untouched.
 *
 * State machine (applied to the active booking intent for the slot):
 *
 *   pending ──Held──▶ confirmed ──Captured──▶ firm
 *      │                 │
 *      │                 ├──Released──▶ cancelled (slot freed)
 *      ├──────────Released──────────┘
 *      ├──────────Refunded──────────▶ cancelled (slot freed)
 *      ├──────────Slashed───────────▶ expired    (slot freed, alert metric)
 *
 *   confirmed ──Refunded──▶ cancelled (slot freed)
 *   confirmed ──Slashed────▶ expired   (slot freed, alert metric)
 *   confirmed ──Released──▶ cancelled (slot freed; service complete payout)
 *
 *   firm ──Released──▶ cancelled (slot freed; service complete payout)
 *   firm ──Refunded──▶ cancelled (slot freed; dispute resolved)
 *   firm ──Slashed────▶ expired   (slot freed, alert metric)
 *
 * Outcomes the projector may emit:
 *   - applied:               state transition applied successfully
 *   - noop_slot_already:      intent was already in the target state (replay)
 *   - noop_terminal_intent:   intent is in cancelled/expired with a NEW target
 *   - noop_illegal_transition:non-terminal intent, but kind has no edge from
 *                             the current state in the table
 *   - noop_unknown_intent:    no active intent exists for the slot the event
 *                             references (or the (id, slot) tuple is malformed)
 *   - noop_rejected_address:  contract address is not in the allow-list
 */

import type {
  BookingIntentRecord,
  BookingIntentRepository,
  BookingIntentStatus,
} from "../modules/booking-intents/booking-intent-repository.js";
import type { SlotRepository } from "../modules/slots/slot-repository.js";
import {
  SchedulingService,
  SlotNotBookableError,
  SlotNotFoundError,
} from "../services/schedulingService.js";
import type { EscrowEvent } from "./escrowEventTypes.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { logger } from "../utils/logger.js";


export type ProjectionResultKind =
  | "applied"
  | "noop_unknown_intent"
  | "noop_slot_already"
  | "noop_terminal_intent"
  | "noop_illegal_transition"
  | "noop_rejected_address";

export interface ProjectionOutcome {
  readonly result: ProjectionResultKind;
  readonly intent: BookingIntentRecord | undefined;
  readonly reason: string;
  readonly slotFreed: boolean;
}

export interface ProjectionCounts {
  applied: number;
  noop_unknown_intent: number;
  noop_slot_already: number;
  noop_terminal_intent: number;
  noop_illegal_transition: number;
  noop_rejected_address: number;
}

export function emptyProjectionCounts(): ProjectionCounts {
  return {
    applied: 0,
    noop_unknown_intent: 0,
    noop_slot_already: 0,
    noop_terminal_intent: 0,
    noop_illegal_transition: 0,
    noop_rejected_address: 0,
  };
}

function noop(
  result: ProjectionResultKind,
  reason: string,
  intent?: BookingIntentRecord,
): ProjectionOutcome {
  return { result, reason, intent, slotFreed: false };
}

/**
 * Each event kind maps to a target booking intent status. Re-applying the
 * same event kind reaches the same target, which is the basis of the
 * idempotent replay semantics.
 */
const TARGET_BY_KIND: Record<EscrowEvent["kind"], BookingIntentStatus> = {
  Held: "confirmed",
  Captured: "firm",
  Released: "cancelled",
  Refunded: "cancelled",
  Slashed: "expired",
};

/**
 * Legal (status, kind) → next-status transitions from a non-terminal state.
 * Terminal states are intentionally absent — they have no outgoing edges.
 */
const STATUS_TRANSITIONS: Record<
  BookingIntentStatus,
  ReadonlyArray<{ kind: EscrowEvent["kind"]; next: BookingIntentStatus }>
> = {
  pending: [
    { kind: "Held", next: "confirmed" },
    { kind: "Released", next: "cancelled" },
    { kind: "Refunded", next: "cancelled" },
    { kind: "Slashed", next: "expired" },
  ],
  confirmed: [
    { kind: "Captured", next: "firm" },
    { kind: "Released", next: "cancelled" },
    { kind: "Refunded", next: "cancelled" },
    { kind: "Slashed", next: "expired" },
  ],
  firm: [
    { kind: "Released", next: "cancelled" },
    { kind: "Refunded", next: "cancelled" },
    { kind: "Slashed", next: "expired" },
  ],
  hold_placed: [
    { kind: "Held", next: "confirmed" },
    { kind: "Captured", next: "firm" },
    { kind: "Released", next: "cancelled" },
    { kind: "Refunded", next: "cancelled" },
    { kind: "Slashed", next: "expired" },
  ],
  hold_refunded: [],
  cancelled: [],
  expired: [],
};

export class EscrowStateProjector {
  private readonly scheduling: SchedulingService;

  constructor(
    private readonly bookingIntentRepository: BookingIntentRepository,
    private readonly slotRepository: SlotRepository,
    /**
     * Allowlist of contract addresses whose events should be projected.
     * Empty array = secure default (reject all events).
     */
    private readonly contractAddressAllowList: ReadonlyArray<string> = [],
  ) {
    this.scheduling = new SchedulingService(this.slotRepository, this.bookingIntentRepository);
  }

  /**
   * Project a single escrow event onto the local state. Never throws on
   * legitimate input — illegal states are recorded as no-ops with a
   * reason so the metrics/counters can be inspected post-hoc.
   */
  async project(event: EscrowEvent): Promise<ProjectionOutcome> {
    if (!this.contractAddressAllowList.includes(event.contractAddress)) {
      return noop(
        "noop_rejected_address",
        `contract ${event.contractAddress} not in allow-list`,
      );
    }

    const intent = this.findActiveIntent(event);
    if (!intent) {
      return noop(
        "noop_unknown_intent",
        `no active intent for slot ${event.slotId}`,
      );
    }

    const target = TARGET_BY_KIND[event.kind];

    // Replay: the intent is already in the target state for this event.
    // We surface this BEFORE the terminal check because it is a benign
    // idempotent re-application (e.g. via a recovered idempotency-store
    // gap), not an error.
    if (intent.status === target) {
      return noop(
        "noop_slot_already",
        `intent ${intent.id} already ${target} (${event.txHash.toLowerCase()}:${event.eventIndex})`,
        intent,
      );
    }

    // Terminal intent with a NEW target — flow diverged, do nothing.
    if (intent.status === "cancelled" || intent.status === "expired") {
      return noop(
        "noop_terminal_intent",
        `intent ${intent.id} is terminal (${intent.status}); cannot apply ${event.kind} → ${target}`,
        intent,
      );
    }

    // Non-terminal: look up the legal (status, kind) edge.
    const edges = STATUS_TRANSITIONS[intent.status];
    if (!edges.some((edge) => edge.kind === event.kind)) {
      return noop(
        "noop_illegal_transition",
        `(intent ${intent.id}) ${event.kind} → ${target} not legal from status ${intent.status}`,
        intent,
      );
    }

    return this.transition(intent, target, event);
  }

  // ─── Lookup helpers ────────────────────────────────────────────────────────

  private findActiveIntent(event: EscrowEvent): BookingIntentRecord | undefined {
    // If the contract annotates the event with a bookingIntentId, the id is
    // authoritative provenance — we MUST use the id-pointer or fail-closed.
    // Silently re-routing to a slot-keyed lookup would obscure intent
    // corruption, so we return undefined in both "id missing" and
    // "id points at a different slot" cases. The caller maps undefined
    // to noop_unknown_intent.
    if (event.bookingIntentId) {
      const byId = this.bookingIntentRepository.findById(event.bookingIntentId);
      if (!byId) return undefined;
      if (byId.slotId !== event.slotId) return undefined;
      return byId;
    }
    return this.lookupBySlot(event.slotId);
  }

  private lookupBySlot(slotId: string): BookingIntentRecord | undefined {
    if (this.bookingIntentRepository.findLatestBySlotId) {
      return this.bookingIntentRepository.findLatestBySlotId(slotId);
    }
    // Fallback for repository implementations that do not provide the
    // indexed lookup. O(n) but only used in tests / legacy repos.
    const all = this.bookingIntentRepository.listAll();
    const candidates = all.filter((i) => i.slotId === slotId);
    if (candidates.length === 0) return undefined;
    return candidates.reduce((latest, current) =>
      current.startTime > latest.startTime ? current : latest,
    );
  }

  // ─── Transition core ──────────────────────────────────────────────────────

  /**
   * Apply a state transition idempotently. Updates the intent status and,
   * when applicable, releases the slot. Tolerates missing/already-released
   * slots so a stale projection cannot wedge the listener.
   * 
   * Emits audit events for firm booking escalation (Captured event).
   */
  private transition(
    intent: BookingIntentRecord,
    nextStatus: BookingIntentStatus,
    event: EscrowEvent,
  ): ProjectionOutcome {
    const updated = this.bookingIntentRepository.updateStatus(intent.id, nextStatus);

    // Emit firm booking receipt when payment is captured
    if (event.kind === "Captured" && nextStatus === "firm") {
      this.emitFirmBookingReceipt(updated, event);
    }

    let slotFreed = false;
    if (nextStatus !== "confirmed" && nextStatus !== "firm") {
      slotFreed = this.tryReleaseSlot(event.slotId);
    }

    return {
      result: "applied",
      intent: updated,
      reason: `applied ${event.kind} -> ${nextStatus}`,
      slotFreed,
    };
  }

  /**
   * Emits audit event and firm booking receipt when a refundable hold
   * is captured and escalated to firm booking.
   */
  private emitFirmBookingReceipt(intent: BookingIntentRecord, event: EscrowEvent): void {
    defaultAuditLogger
      .log("escrow.capture.firm_booking", {
        context: {
          intentId: intent.id,
          slotId: intent.slotId,
          customerId: intent.customerId,
          professional: intent.professional,
          txHash: event.txHash,
          eventIndex: event.eventIndex,
          ledgerSeq: event.ledgerSeq,
          contractAddress: event.contractAddress,
          amount: event.amount,
          captureTime: event.closeTime,
        },
      }, { status: "success", resource: `booking:${intent.id}` })
      .catch((err) => {
        logger.error("Failed to emit firm booking receipt:", err);
      });
  }

  private tryReleaseSlot(slotId: string): boolean {
    const slot = this.slotRepository.findById(slotId);
    if (!slot) return false;
    if (slot.bookable) return false;
    try {
      this.scheduling.releaseSlot(slotId);
      return true;
    } catch (err) {
      if (err instanceof SlotNotFoundError) return false;
      if (err instanceof SlotNotBookableError) return false;
      throw err;
    }
  }
}

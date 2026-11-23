/**
 * bundleTransferabilityService.ts
 *
 * Manages slot bundle transferability rules — suppliers may choose whether
 * their bundles are transferable in the secondary market (resale).
 *
 * Key behaviours:
 *  - A slot with `transferable === false` blocks resale listing via
 *    `assertBundleTransferable()`.
 *  - Admins may override the restriction; each override is audit-logged.
 *  - The flag defaults to `true` so existing slots are implicitly transferable.
 */

import type { SlotRecord, SlotRepository } from "../modules/slots/slot-repository.js";
import type { AuthContext } from "../middleware/auth.js";
import { BundleNotTransferableError } from "./schedulingService.js";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";

/** Audit action constant for admin transferability overrides. */
export const AUDIT_ACTION_BUNDLE_TRANSFER_OVERRIDE =
  "admin.bundle.transferability.override";

/**
 * Indicates why an assertion failed.
 */
export interface AssertionFailureDetail {
  slotId: string;
  transferable: boolean;
}

/**
 * Result of an admin override operation.
 */
export interface AdminOverrideResult {
  slotId: string;
  transferable: boolean;
  previousValue: boolean;
  overriddenBy: string;
  overriddenAt: string;
}

/**
 * Encapsulates transferability checks and admin overrides with audit logging.
 */
export class BundleTransferabilityService {
  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly auditLogger: AuditLogger = defaultAuditLogger,
  ) {}

  // ── Public query helpers ────────────────────────────────────────────────

  /**
   * Returns whether a slot's bundle is transferable.
   * Defaults to `true` for backward compatibility when the field is undefined.
   */
  isTransferable(slot: SlotRecord): boolean {
    return slot.transferable !== false;
  }

  /**
   * Asserts that the slot's bundle is transferable.
   *
   * - If the slot is **not transferable** AND the actor is **not an admin**,
   *   throws `BundleNotTransferableError`.
   * - Admins bypass the restriction (used for support/override scenarios).
   * - When `actor` is omitted (internal call), the check is strict.
   *
   * @throws {BundleNotTransferableError} when the bundle is not transferable
   *         and no admin override is present.
   */
  assertBundleTransferable(
    slot: SlotRecord,
    actor?: AuthContext,
  ): void {
    if (this.isTransferable(slot)) {
      return; // Fast path — transferable
    }

    // Admin override: admins can bypass transferability checks
    if (actor && actor.role === "admin") {
      return;
    }

    throw new BundleNotTransferableError(slot.id);
  }

  // ── Admin override ──────────────────────────────────────────────────────

  /**
   * Admin-only operation that updates a slot's transferable flag and records
   * an audit event.
   *
   * @param slotId  - The slot to modify.
   * @param value   - New transferable value.
   * @param actor   - The admin performing the override (must have role "admin").
   * @returns       - Result with previous and new state.
   * @throws {Error} when the slot is not found or the actor is not admin.
   */
  async adminSetTransferable(
    slotId: string,
    value: boolean,
    actor: AuthContext,
  ): Promise<AdminOverrideResult> {
    if (actor.role !== "admin") {
      throw new Error(
        `Only admins may override transferability. User "${actor.userId}" has role "${actor.role}".`,
      );
    }

    const slot = this.slotRepository.findById(slotId);
    if (!slot) {
      throw new Error(`Slot ${slotId} not found`);
    }

    const previousValue = this.isTransferable(slot);

    // Update the slot's transferable flag via repository mutation.
    // Since the in-memory repo returns copies, we need to access the internal
    // slots array.  We cast to `any` to reach the internal store — production
    // code would use a proper repository method.
    const internalSlots = (this.slotRepository as any).slots as SlotRecord[];
    const target = internalSlots.find((s: SlotRecord) => s.id === slotId);
    if (target) {
      target.transferable = value;
    }

    const now = new Date().toISOString();

    // Audit-log the override
    await this.auditLogger.log(AUDIT_ACTION_BUNDLE_TRANSFER_OVERRIDE, {
      context: {
        slotId,
        previousValue,
        newValue: value,
        overriddenBy: actor.userId,
        overriddenAt: now,
      },
      userId: actor.userId,
    }, {
      resource: `slot:${slotId}`,
      status: 200,
    });

    return {
      slotId,
      transferable: value,
      previousValue,
      overriddenBy: actor.userId,
      overriddenAt: now,
    };
  }

  /**
   * Convenience method: returns slots that are transferable for use in
   * marketplace listings. Filters out non-transferable slots.
   */
  filterTransferable(slots: SlotRecord[]): SlotRecord[] {
    return slots.filter((slot) => this.isTransferable(slot));
  }
}

import type { SlotRepository, SlotRecord } from "../modules/slots/slot-repository.js";
import type { ReminderRepository } from "../models/reminder.js";

/** Default lead time before bundle expiry to send a reminder ping (1 hour). */
const DEFAULT_REMINDER_LEAD_MS = 60 * 60 * 1000;

export interface ScheduleExpiryReminderInput {
  slotId: string;
  /** How long before validUntil to fire the reminder. Defaults to 1 hour. */
  leadTimeMs?: number;
}

/**
 * Thrown when a slot id cannot be used to schedule a reminder. Ids are never
 * coerced into something else: a bad id fails here instead of silently
 * becoming a reminder for the wrong slot.
 */
export class InvalidSlotIdError extends Error {
  constructor(public readonly slotId: unknown) {
    super(`Invalid slot id: expected a non-empty string, received ${describeValue(slotId)}`);
    this.name = "InvalidSlotIdError";
  }
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/**
 * Schedules reminder pings that fire before a bundle's validUntil deadline.
 *
 * Each reminder is persisted via the existing ReminderRepository so the
 * worker can pick it up after restarts. The reminder is stored under the
 * slot's real id, and a reminder that already exists for the same slot and
 * trigger time (in any status) is left alone, so repeated sweeps never
 * produce repeat pings.
 *
 * Idempotency is check-then-create. Calls in the same process are serialised
 * per slot/trigger; two separate processes sweeping at the same instant can
 * still both create one, which only a unique index in the database can
 * prevent.
 */
export class BundleExpiryService {
  /** slotId + triggerAt pairs currently being scheduled by this instance. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly reminderRepository: ReminderRepository,
  ) {}

  /**
   * Schedule a reminder that fires `leadTimeMs` before the slot's validUntil.
   *
   * @returns `true` if a new reminder was created; `false` if nothing was
   *          created because the trigger time has already passed or a
   *          reminder for this slot and trigger time already exists.
   * @throws {InvalidSlotIdError} if the slot id is not a non-empty string.
   * @throws {Error} if the slot is not found or has no validUntil configured.
   */
  async scheduleExpiryReminder(
    input: ScheduleExpiryReminderInput,
  ): Promise<boolean> {
    if (typeof input.slotId !== "string" || input.slotId.trim() === "") {
      throw new InvalidSlotIdError(input.slotId);
    }

    const slot = this.slotRepository.findById(input.slotId);
    if (!slot) {
      throw new Error(`Slot ${input.slotId} not found`);
    }
    if (slot.validUntil === undefined || slot.validUntil === null) {
      throw new Error(`Slot ${input.slotId} has no validUntil configured`);
    }

    const leadTimeMs = input.leadTimeMs ?? DEFAULT_REMINDER_LEAD_MS;
    const triggerAt = slot.validUntil - leadTimeMs;

    if (triggerAt < Date.now()) {
      return false;
    }

    const key = `${slot.id}\u0000${triggerAt}`;
    if (this.inFlight.has(key)) {
      return false;
    }
    this.inFlight.add(key);

    try {
      const existing = await this.reminderRepository.findBySlotAndTrigger(
        slot.id,
        triggerAt,
      );
      if (existing) {
        return false;
      }

      await this.reminderRepository.create({ slotId: slot.id, triggerAt });
      return true;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Finds all slots with a validUntil that is approaching and schedules
   * reminders for any that do not yet have one.
   *
   * Intended to be called periodically by a cron or worker loop.
   *
   * @returns the number of reminders newly created by this run. Slots that
   *          already had a reminder are not counted.
   */
  async scheduleExpiringBundleReminders(): Promise<number> {
    const now = Date.now();
    const allSlots = this.slotRepository.list();
    let scheduled = 0;

    for (const slot of allSlots) {
      if (slot.validUntil === undefined || slot.validUntil === null) {
        continue;
      }
      const leadTimeMs = DEFAULT_REMINDER_LEAD_MS;
      const triggerAt = slot.validUntil - leadTimeMs;
      if (triggerAt < now || slot.validUntil <= now) {
        continue;
      }

      if (await this.scheduleExpiryReminder({ slotId: slot.id })) {
        scheduled++;
      }
    }

    return scheduled;
  }

  /**
   * Checks whether a slot's bundle has expired.
   */
  isExpired(slot: SlotRecord, now?: number): boolean {
    if (slot.validUntil === undefined || slot.validUntil === null) {
      return false;
    }
    return (now ?? Date.now()) >= slot.validUntil;
  }
}

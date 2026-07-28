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
 * Schedules reminder pings that fire before a bundle's validUntil deadline.
 *
 * Each reminder is persisted via the existing ReminderRepository so the
 * worker can pick it up after restarts. Duplicate reminders for the same
 * slot are silently ignored (idempotent).
 */
export class BundleExpiryService {
  constructor(
    private readonly slotRepository: SlotRepository,
    private readonly reminderRepository: ReminderRepository,
  ) {}

  /**
   * Schedule a reminder that fires `leadTimeMs` before the slot's validUntil.
   *
   * @throws {Error} if the slot has no validUntil configured.
   */
  async scheduleExpiryReminder(
    input: ScheduleExpiryReminderInput,
  ): Promise<void> {
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
      return;
    }

    await this.reminderRepository.create({
      slotId: Number(input.slotId.replace(/[^0-9]/g, "")) || 0,
      triggerAt,
    });
  }

  /**
   * Finds all slots with a validUntil that is approaching and schedules
   * reminders for any that do not yet have one.
   *
   * Intended to be called periodically by a cron or worker loop.
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

      await this.scheduleExpiryReminder({ slotId: slot.id });
      scheduled++;
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

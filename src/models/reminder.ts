export type ReminderStatus = "pending" | "sent" | "failed";

/**
 * Identifier of the slot a reminder belongs to.
 *
 * Reminders created through the reminder API use positive integers. Slots
 * themselves are identified by strings (`slot-<uuid>` in memory, UUIDs in
 * Postgres), so reminders scheduled by `BundleExpiryService` carry the slot's
 * real string id.
 */
export type ReminderSlotId = number | string;

/**
 * Canonical form of a slot id. A canonical decimal string (digits only, no
 * leading zeros) that fits in a safe integer becomes a number, so legacy
 * integer reminders round-trip as numbers; anything else stays a string.
 * Every repository uses this so they return identical values for the same
 * input.
 */
export function normalizeReminderSlotId(slotId: ReminderSlotId): ReminderSlotId {
  if (typeof slotId === "string" && /^(0|[1-9]\d*)$/.test(slotId)) {
    const asNumber = Number(slotId);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }
  return slotId;
}

/** Whether two slot ids refer to the same slot (`12` and `"12"` do). */
export function isSameReminderSlot(a: ReminderSlotId, b: ReminderSlotId): boolean {
  return String(a) === String(b);
}

export interface Reminder {
  id: string;
  slotId: ReminderSlotId;
  triggerAt: number;
  status: ReminderStatus;
  attempts: number;
  lastAttemptAt?: number;
  sentAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateReminderInput {
  slotId: ReminderSlotId;
  triggerAt: number;
}

export interface ReminderRepository {
  create(input: CreateReminderInput): Promise<Reminder>;
  findById(id: string): Promise<Reminder | null>;
  /**
   * Returns the reminder for this slot and trigger time, in any status, or
   * null. Used to keep scheduling idempotent.
   */
  findBySlotAndTrigger(slotId: ReminderSlotId, triggerAt: number): Promise<Reminder | null>;
  getDueReminders(now: number, limit?: number): Promise<Reminder[]>;
  markSent(id: string, sentAt?: number): Promise<Reminder | null>;
  recordAttempt(id: string, attemptedAt?: number): Promise<Reminder | null>;
  markFailed(id: string, failedAt?: number): Promise<Reminder | null>;
}

const cloneReminder = (reminder: Reminder): Reminder => ({ ...reminder });

let reminderIdCounter = 1;
const inMemoryReminders: Reminder[] = [];

export class InMemoryReminderRepository implements ReminderRepository {
  async create(input: CreateReminderInput): Promise<Reminder> {
    const now = Date.now();
    const reminder: Reminder = {
      id: `reminder-${reminderIdCounter++}`,
      slotId: normalizeReminderSlotId(input.slotId),
      triggerAt: input.triggerAt,
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };

    inMemoryReminders.push(reminder);
    return cloneReminder(reminder);
  }

  async findById(id: string): Promise<Reminder | null> {
    const reminder = inMemoryReminders.find((entry) => entry.id === id);
    return reminder ? cloneReminder(reminder) : null;
  }

  async findBySlotAndTrigger(
    slotId: ReminderSlotId,
    triggerAt: number,
  ): Promise<Reminder | null> {
    const reminder = inMemoryReminders.find(
      (entry) => isSameReminderSlot(entry.slotId, slotId) && entry.triggerAt === triggerAt,
    );
    return reminder ? cloneReminder(reminder) : null;
  }

  async getDueReminders(now: number, limit = 100): Promise<Reminder[]> {
    return inMemoryReminders
      .filter((reminder) => reminder.status === "pending" && reminder.triggerAt <= now)
      .slice(0, limit)
      .map(cloneReminder);
  }

  async markSent(id: string, sentAt = Date.now()): Promise<Reminder | null> {
    return this.updateReminder(id, (reminder) => {
      reminder.status = "sent";
      reminder.sentAt = sentAt;
    });
  }

  async recordAttempt(id: string, attemptedAt = Date.now()): Promise<Reminder | null> {
    return this.updateReminder(id, (reminder) => {
      reminder.attempts += 1;
      reminder.lastAttemptAt = attemptedAt;
      reminder.updatedAt = attemptedAt;
    });
  }

  async markFailed(id: string, failedAt = Date.now()): Promise<Reminder | null> {
    return this.updateReminder(id, (reminder) => {
      reminder.status = "failed";
      reminder.updatedAt = failedAt;
      reminder.lastAttemptAt = failedAt;
    });
  }

  reset(): void {
    inMemoryReminders.splice(0, inMemoryReminders.length);
    reminderIdCounter = 1;
  }

  private updateReminder(
    id: string,
    mutator: (reminder: Reminder) => void,
  ): Reminder | null {
    const index = inMemoryReminders.findIndex((reminder) => reminder.id === id);
    if (index === -1) {
      return null;
    }

    mutator(inMemoryReminders[index]);
    inMemoryReminders[index].updatedAt = Date.now();
    return cloneReminder(inMemoryReminders[index]);
  }
}

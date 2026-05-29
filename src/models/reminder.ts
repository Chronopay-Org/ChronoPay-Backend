export type ReminderStatus = "pending" | "sent" | "failed";

export interface Reminder {
  id: string;
  slotId: number;
  triggerAt: number;
  status: ReminderStatus;
  attempts: number;
  lastAttemptAt?: number;
  sentAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateReminderInput {
  slotId: number;
  triggerAt: number;
}

export interface ReminderRepository {
  create(input: CreateReminderInput): Promise<Reminder>;
  findById(id: string): Promise<Reminder | null>;
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
      slotId: input.slotId,
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

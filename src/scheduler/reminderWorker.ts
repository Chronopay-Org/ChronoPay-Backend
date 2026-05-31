import { type Reminder, type ReminderRepository } from "../models/reminder.js";
import { claimDelivery } from "./reminderDedup.js";
import { reminderMetrics } from "./reminderMetrics.js";
import { getReminderRepository } from "../repositories/reminderRepository.js";

const MAX_RETRIES = 3;

export interface ProcessRemindersOptions {
  repository?: ReminderRepository;
  now?: number;
  maxRetries?: number;
  deliverReminder?: (reminder: Reminder) => Promise<void> | void;
  claimDeliveryFn?: typeof claimDelivery;
}

async function defaultDeliverReminder(reminder: Reminder): Promise<void> {
  console.log(`[reminder] delivering id=${reminder.id} slotId=${reminder.slotId}`);
}

export async function processReminders(options: ProcessRemindersOptions = {}) {
  const repository = options.repository ?? getReminderRepository();
  const now = options.now ?? Date.now();
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const dueReminders = await repository.getDueReminders(now);

  for (const reminder of dueReminders) {
    // ── Deduplication check ──────────────────────────────────────────────────
    const claimDeliveryFn = options.claimDeliveryFn ?? claimDelivery;
    // @ts-expect-error - Auto-fixed by script
    const claimed = await claimDeliveryFn(reminder.id, reminder.triggerAt);
    if (!claimed) {
      console.log(`[reminder] skipped duplicate id=${reminder.id} triggerAt=${reminder.triggerAt}`);
      reminderMetrics.increment("skipped");
      continue;
    }

    // ── Deliver ──────────────────────────────────────────────────────────────
    try {
      const deliverReminder = options.deliverReminder ?? defaultDeliverReminder;
      await deliverReminder(reminder);
      await repository.markSent(reminder.id, now);
      reminderMetrics.increment("delivered");
      console.log(`[reminder] delivered id=${reminder.id}`);
    } catch (error) {
      const updated = await repository.recordAttempt(reminder.id, now);
      const attempts = updated?.attempts ?? reminder.attempts + 1;

      if (attempts >= maxRetries) {
        await repository.markFailed(reminder.id, now);
        reminderMetrics.increment("failed");
        console.error(`[reminder] failed id=${reminder.id} attempts=${attempts}`);
      } else {
        console.warn(`[reminder] retry scheduled id=${reminder.id} attempts=${attempts}`);
      }

      if (error instanceof Error) {
        console.error(`[reminder] delivery error id=${reminder.id}: ${error.message}`);
      }
    }
  }
}

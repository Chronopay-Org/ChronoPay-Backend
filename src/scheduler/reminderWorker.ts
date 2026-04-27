import { ReminderStore } from "../models/reminder.js";
import { claimDelivery } from "./reminderDedup.js";
import { reminderMetrics } from "./reminderMetrics.js";

const MAX_RETRIES = 3;

export async function processReminders() {
  const now = Date.now();
  const dueReminders = ReminderStore.getDueReminders(now);

  for (const reminder of dueReminders) {
    // ── Deduplication check ──────────────────────────────────────────────────
    const claimed = await claimDelivery(reminder.id, reminder.triggerAt);
    if (!claimed) {
      console.log(`[reminder] skipped duplicate id=${reminder.id} triggerAt=${reminder.triggerAt}`);
      reminderMetrics.increment("skipped");
      continue;
    }

    // ── Deliver ──────────────────────────────────────────────────────────────
    try {
      console.log(`[reminder] delivering id=${reminder.id} slotId=${reminder.slotId}`);
      // Simulate notification (replace with email/SMS later)
      reminder.status = "sent";
      reminderMetrics.increment("delivered");
      console.log(`[reminder] delivered id=${reminder.id}`);
    } catch (error) {
      reminder.attempts += 1;
      if (reminder.attempts >= MAX_RETRIES) {
        reminder.status = "failed";
        reminderMetrics.increment("failed");
        console.error(`[reminder] failed id=${reminder.id} attempts=${reminder.attempts}`);
      }
    }

    ReminderStore.update(reminder);
  }
}

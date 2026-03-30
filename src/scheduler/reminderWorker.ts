import { ReminderStore } from "../models/reminder.js";

const MAX_RETRIES = 3;

export async function processReminders() {
    const now = Date.now();
    const dueReminders = ReminderStore.getDueReminders(now);

    for (const reminder of dueReminders) {
        try {
            // Simulate notification (replace with email/SMS later)
            console.log(`Sending reminder for slot ${reminder.slotId}`);

            reminder.status = "sent";
        } catch (error) {
            reminder.attempts += 1;

            if (reminder.attempts >= MAX_RETRIES) {
                reminder.status = "failed";
            }
        }

        ReminderStore.update(reminder);
    }
}
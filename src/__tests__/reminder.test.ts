import { scheduleReminders } from "../services/reminderService.js";
import { ReminderStore } from "../models/reminder.js";
import { processReminders } from "../scheduler/reminderWorker.js";

describe("Reminder system", () => {
    beforeEach(() => {
        ReminderStore.reset();
    });

    it("should schedule reminders", () => {
        const startTime = Date.now() + 2 * 60 * 60 * 1000;

        const reminders = scheduleReminders(1, startTime);

        expect(reminders.length).toBeGreaterThan(0);
    });

    it("should process reminders", async () => {
        const startTime = Date.now() + 2000;

        scheduleReminders(1, startTime);

        await new Promise((r) => setTimeout(r, 3000));

        await processReminders();

        const due = ReminderStore.getDueReminders(Date.now());
        expect(due.length).toBe(0);
    });

    it("should not schedule past reminders", () => {
        const startTime = Date.now() + 1000;

        const reminders = scheduleReminders(1, startTime);

        expect(reminders.length).toBe(0);
    });
});
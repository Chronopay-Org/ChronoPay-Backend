import { ReminderStore } from "../models/reminder.js";

const DEFAULT_REMINDER_OFFSETS = [60 * 60 * 1000];

export function scheduleReminders(slotId: number, startTime: number) {
    return DEFAULT_REMINDER_OFFSETS.map((offset) => {
        const triggerAt = startTime - offset;

        if (triggerAt <= Date.now()) return null;

        return ReminderStore.create({
            slotId,
            triggerAt,
        });
    }).filter(Boolean);
}
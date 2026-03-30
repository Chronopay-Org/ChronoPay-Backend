export type ReminderStatus = "pending" | "sent" | "failed";

export interface Reminder {
    id: number;
    slotId: number;
    triggerAt: number;
    status: ReminderStatus;
    attempts: number;
}

let reminders: Reminder[] = [];
let idCounter = 1;

export const ReminderStore = {
    create(reminder: Omit<Reminder, "id" | "status" | "attempts">) {
        const newReminder: Reminder = {
            id: idCounter++,
            status: "pending",
            attempts: 0,
            ...reminder,
        };
        reminders.push(newReminder);
        return newReminder;
    },

    getDueReminders(now: number) {
        return reminders.filter(
            (r) => r.status === "pending" && r.triggerAt <= now,
        );
    },

    update(reminder: Reminder) {
        const index = reminders.findIndex((r) => r.id === reminder.id);
        if (index !== -1) reminders[index] = reminder;
    },

    reset() {
        reminders = [];
        idCounter = 1;
    },
};
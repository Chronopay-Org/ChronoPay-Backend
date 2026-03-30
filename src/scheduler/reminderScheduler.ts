import { processReminders } from "./reminderWorker.js";

let interval: NodeJS.Timeout;

export function startScheduler() {
    interval = setInterval(() => {
        processReminders();
    }, 5000); // every 5 seconds
}

export function stopScheduler() {
    clearInterval(interval);
}
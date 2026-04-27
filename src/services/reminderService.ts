import { ReminderStore } from "../models/reminder.js";
import { isValidIANATimezone } from "../validation/reminderValidation.js";
import { ReminderValidationError } from "../types/reminder.js";

const DEFAULT_REMINDER_OFFSETS = [60 * 60 * 1000];

/**
 * Schedules one or more reminders ahead of a slot's start time.
 *
 * Performs type-level validation before touching the store. For full
 * business-rule validation (minimum lead time, maximum look-ahead window)
 * use {@link validateReminderScheduleInput} in the calling route handler.
 *
 * @param slotId    - Positive integer slot identifier.
 * @param startTime - UTC epoch milliseconds for the slot start.
 * @param timezone  - Optional IANA timezone string. Validated but does not
 *                    alter the UTC-based trigger calculation.
 * @throws {ReminderValidationError} When any input fails type-level checks.
 */
export function scheduleReminders(slotId: number, startTime: number, timezone?: string) {
    const errors: string[] = [];

    if (typeof slotId !== "number" || !Number.isInteger(slotId) || slotId <= 0) {
        errors.push("slotId must be a positive integer");
    }

    if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime <= 0) {
        errors.push("startTime must be a positive finite number (epoch milliseconds)");
    }

    if (timezone !== undefined && !isValidIANATimezone(timezone)) {
        errors.push("timezone must be a valid IANA timezone identifier");
    }

    if (errors.length > 0) {
        throw new ReminderValidationError(errors);
    }

    return DEFAULT_REMINDER_OFFSETS.map((offset) => {
        const triggerAt = startTime - offset;

        if (triggerAt <= Date.now()) return null;

        return ReminderStore.create({
            slotId,
            triggerAt,
        });
    }).filter(Boolean);
}
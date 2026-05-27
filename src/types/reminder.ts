export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';


export interface Reminder {
    id: string;
    bookingId: string;
    userId: string;
    scheduledFor: Date;
    /** IANA timezone in which the reminder time was originally expressed. */
    timezone: string;
    reminderType: 'booking_confirmation' | 'booking_reminder' | 'payment_reminder';
    status: ReminderStatus;
    attempts: number;
    lastAttemptAt?: Date;
    createdAt: Date;
    updatedAt: Date;
    metadata?: Record<string, any>;
}

export interface CreateReminderDTO {
    bookingId: string;
    userId: string;
    scheduledFor: Date;
    /**
     * IANA timezone identifier for the reminder time.
     * Defaults to UTC when omitted. Example: "America/New_York", "Europe/London".
     */
    timezone?: string;
    reminderType: Reminder['reminderType'];
    metadata?: Record<string, any>;
}

export interface ReminderConfig {
    bookingConfirmationDelayMinutes: number;
    reminderBeforeMinutes: number[];
    paymentReminderHours: number[];
    maxRetryAttempts: number;
    retryDelayMinutes: number;
}

/**
 * Thrown by the reminder service when scheduling inputs fail validation.
 *
 * Aggregates all constraint violations in a sanitized form — raw input values
 * are never included in the message to prevent accidental data leakage.
 */
export class ReminderValidationError extends Error {
    readonly issues: string[];

    constructor(issues: string[]) {
        super(
            `Invalid reminder schedule input:\n${issues.map((i) => `- ${i}`).join("\n")}`,
        );
        this.name = "ReminderValidationError";
        this.issues = issues;
    }
}
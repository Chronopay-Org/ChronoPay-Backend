export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface Reminder {
    id: string;
    bookingId: string;
    userId: string;
    scheduledFor: Date;
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
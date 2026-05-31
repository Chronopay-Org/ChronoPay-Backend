import type { QueryResult } from "pg";
import type { CreateReminderInput, Reminder, ReminderRepository } from "../models/reminder.js";

type DbQuery = (text: string, params?: unknown[]) => Promise<QueryResult>;

const defaultDbQuery: DbQuery = async (text, params) => {
  const { query } = await import("../db/pool.js");
  return query(text, params);
};

let defaultRepository: ReminderRepository | null = null;

export function getReminderRepository(): ReminderRepository {
  if (!defaultRepository) {
    defaultRepository = new PgReminderRepository();
  }

  return defaultRepository;
}

export function setReminderRepositoryForTests(repository: ReminderRepository | null): void {
  defaultRepository = repository;
}

export class PgReminderRepository implements ReminderRepository {
  constructor(private readonly dbQuery: DbQuery = defaultDbQuery) {}

  async create(input: CreateReminderInput): Promise<Reminder> {
    const now = Date.now();
    const result = await this.dbQuery(
      `
        INSERT INTO reminders (
          slot_id,
          trigger_at,
          status,
          attempts,
          created_at,
          updated_at
        ) VALUES ($1, to_timestamp($2 / 1000.0), 'pending', 0, to_timestamp($3 / 1000.0), to_timestamp($3 / 1000.0))
        RETURNING *
      `,
      [input.slotId, input.triggerAt, now],
    );

    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<Reminder | null> {
    const result = await this.dbQuery(
      `
        SELECT *
        FROM reminders
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async getDueReminders(now: number, limit = 100): Promise<Reminder[]> {
    const result = await this.dbQuery(
      `
        SELECT *
        FROM reminders
        WHERE status = 'pending'
          AND trigger_at <= to_timestamp($1 / 1000.0)
        ORDER BY trigger_at ASC, created_at ASC
        LIMIT $2
      `,
      [now, limit],
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async markSent(id: string, sentAt = Date.now()): Promise<Reminder | null> {
    const result = await this.dbQuery(
      `
        UPDATE reminders
        SET status = 'sent',
            sent_at = to_timestamp($2 / 1000.0),
            updated_at = to_timestamp($2 / 1000.0)
        WHERE id = $1
        RETURNING *
      `,
      [id, sentAt],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async recordAttempt(id: string, attemptedAt = Date.now()): Promise<Reminder | null> {
    const result = await this.dbQuery(
      `
        UPDATE reminders
        SET attempts = attempts + 1,
            last_attempt_at = to_timestamp($2 / 1000.0),
            updated_at = to_timestamp($2 / 1000.0)
        WHERE id = $1
        RETURNING *
      `,
      [id, attemptedAt],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async markFailed(id: string, failedAt = Date.now()): Promise<Reminder | null> {
    const result = await this.dbQuery(
      `
        UPDATE reminders
        SET status = 'failed',
            last_attempt_at = to_timestamp($2 / 1000.0),
            updated_at = to_timestamp($2 / 1000.0)
        WHERE id = $1
        RETURNING *
      `,
      [id, failedAt],
    );

    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  private mapRow(row: any): Reminder {
    return {
      id: row.id,
      slotId: Number(row.slot_id),
      triggerAt: new Date(row.trigger_at).getTime(),
      status: row.status,
      attempts: Number(row.attempts),
      lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).getTime() : undefined,
      sentAt: row.sent_at ? new Date(row.sent_at).getTime() : undefined,
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }
}

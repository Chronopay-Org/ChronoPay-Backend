import type { QueryResult } from "pg";
import type {
  CreateRecurrenceSeriesInput,
  RecurrenceSeries,
  RecurrenceSeriesRepository,
} from "../models/recurrenceSeries.js";

type DbQuery = (text: string, params?: unknown[]) => Promise<QueryResult>;

const defaultDbQuery: DbQuery = async (text, params) => {
  const { query } = await import("../db/pool.js");
  return query(text, params);
};

let defaultRepository: RecurrenceSeriesRepository | null = null;

export function getRecurrenceSeriesRepository(): RecurrenceSeriesRepository {
  if (!defaultRepository) {
    defaultRepository = new PgRecurrenceSeriesRepository();
  }
  return defaultRepository;
}

export function setRecurrenceSeriesRepositoryForTests(
  repository: RecurrenceSeriesRepository | null,
): void {
  defaultRepository = repository;
}

export class PgRecurrenceSeriesRepository implements RecurrenceSeriesRepository {
  constructor(private readonly dbQuery: DbQuery = defaultDbQuery) {}

  async create(input: CreateRecurrenceSeriesInput): Promise<RecurrenceSeries> {
    const result = await this.dbQuery(
      `INSERT INTO recurrence_series (rrule) VALUES ($1) RETURNING *`,
      [input.rrule],
    );
    return this.mapRow(result.rows[0]);
  }

  async findById(id: string): Promise<RecurrenceSeries | null> {
    const result = await this.dbQuery(
      `SELECT * FROM recurrence_series WHERE id = $1 LIMIT 1`,
      [id],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async updateRRule(id: string, rrule: string): Promise<RecurrenceSeries | null> {
    const result = await this.dbQuery(
      `UPDATE recurrence_series
       SET rrule = $2,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, rrule],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async listAll(): Promise<RecurrenceSeries[]> {
    const result = await this.dbQuery(
      `SELECT * FROM recurrence_series ORDER BY created_at ASC`,
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.dbQuery(
      `DELETE FROM recurrence_series WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: any): RecurrenceSeries {
    return {
      id: row.id,
      rrule: row.rrule,
      version: Number(row.version),
      createdAt: new Date(row.created_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
    };
  }
}

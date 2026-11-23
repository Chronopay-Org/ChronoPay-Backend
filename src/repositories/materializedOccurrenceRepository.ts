import type { QueryResult } from "pg";
import type {
  BulkUpsertOccurrenceInput,
  MaterializedOccurrence,
  MaterializedOccurrenceRepository,
} from "../models/materializedOccurrence.js";

type DbQuery = (text: string, params?: unknown[]) => Promise<QueryResult>;

const defaultDbQuery: DbQuery = async (text, params) => {
  const { query } = await import("../db/pool.js");
  return query(text, params);
};

let defaultRepository: MaterializedOccurrenceRepository | null = null;

export function getMaterializedOccurrenceRepository(): MaterializedOccurrenceRepository {
  if (!defaultRepository) {
    defaultRepository = new PgMaterializedOccurrenceRepository();
  }
  return defaultRepository;
}

export function setMaterializedOccurrenceRepositoryForTests(
  repository: MaterializedOccurrenceRepository | null,
): void {
  defaultRepository = repository;
}

export class PgMaterializedOccurrenceRepository
  implements MaterializedOccurrenceRepository
{
  constructor(private readonly dbQuery: DbQuery = defaultDbQuery) {}

  async bulkUpsert(input: BulkUpsertOccurrenceInput): Promise<MaterializedOccurrence[]> {
    const client = await this.getClient();

    try {
      // Wrap DELETE + INSERT in a transaction for atomicity
      await client.query("BEGIN");

      // Delete all current occurrences for this series
      await client.query(`DELETE FROM materialized_occurrences WHERE series_id = $1`, [
        input.seriesId,
      ]);

      if (input.occurrenceDates.length === 0) {
        await client.query("COMMIT");
        return [];
      }

      // Build multi-row INSERT
      const values: unknown[] = [];
      const placeholders: string[] = [];

      input.occurrenceDates.forEach((date, i) => {
        const base = i * 4;
        placeholders.push(
          `($${base + 1}::uuid, $${base + 2}::integer, $${base + 3}::timestamptz, $${base + 4}::timestamptz)`,
        );
        values.push(
          input.seriesId,
          input.seriesVersion,
          new Date(date),
          new Date(input.materializedAt),
        );
      });

      const result = await client.query(
        `INSERT INTO materialized_occurrences (series_id, series_version, occurrence_date, materialized_at)
         VALUES ${placeholders.join(", ")}
         RETURNING *`,
        values,
      );

      await client.query("COMMIT");
      return result.rows.map((row) => this.mapRow(row));
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_rollbackErr) {
        // Silently ignore rollback failures; re-throw the original error below
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async findBySeriesId(
    seriesId: string,
    fromMs: number,
    toMs: number,
  ): Promise<MaterializedOccurrence[]> {
    const result = await this.dbQuery(
      `SELECT DISTINCT ON (occurrence_date) *
       FROM materialized_occurrences
       WHERE series_id = $1
         AND occurrence_date >= $2
         AND occurrence_date <= $3
       ORDER BY occurrence_date ASC, series_version DESC`,
      [seriesId, new Date(fromMs), new Date(toMs)],
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async cleanStaleVersions(seriesId: string, currentVersion: number): Promise<number> {
    const result = await this.dbQuery(
      `DELETE FROM materialized_occurrences
       WHERE series_id = $1 AND series_version < $2`,
      [seriesId, currentVersion],
    );
    return result.rowCount ?? 0;
  }

  async cleanExpired(beforeMs: number): Promise<number> {
    const result = await this.dbQuery(
      `DELETE FROM materialized_occurrences WHERE occurrence_date < $1`,
      [new Date(beforeMs)],
    );
    return result.rowCount ?? 0;
  }

  async deleteBySeriesId(seriesId: string): Promise<number> {
    const result = await this.dbQuery(
      `DELETE FROM materialized_occurrences WHERE series_id = $1`,
      [seriesId],
    );
    return result.rowCount ?? 0;
  }

  private async getClient() {
    const { default: pool } = await import("../db/pool.js");
    return pool.connect();
  }

  private mapRow(row: any): MaterializedOccurrence {
    return {
      id: row.id,
      seriesId: row.series_id,
      seriesVersion: Number(row.series_version),
      occurrenceDate: new Date(row.occurrence_date).getTime(),
      materializedAt: new Date(row.materialized_at).getTime(),
      createdAt: new Date(row.created_at).getTime(),
    };
  }
}

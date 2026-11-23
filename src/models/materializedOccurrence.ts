/**
 * materializedOccurrence.ts
 *
 * Domain model for pre-materialized RRULE occurrences.
 * Each occurrence belongs to a recurrence series and carries the series version
 * at the time of materialization so stale entries can be filtered.
 */

export interface MaterializedOccurrence {
  id: string;
  /** FK to recurrence_series.id */
  seriesId: string;
  /** The series version at the time this occurrence was materialized. */
  seriesVersion: number;
  /** The actual occurrence date (Unix ms). */
  occurrenceDate: number;
  /** When this occurrence was materialized (Unix ms). */
  materializedAt: number;
  createdAt: number;
}

export interface BulkUpsertOccurrenceInput {
  seriesId: string;
  seriesVersion: number;
  occurrenceDates: number[];
  materializedAt: number;
}

export interface MaterializedOccurrenceRepository {
  /**
   * Replaces all occurrences for a given series/version window with a fresh set.
   * Implementations should delete old entries matching (seriesId) and insert
   * the new batch atomically.
   */
  bulkUpsert(input: BulkUpsertOccurrenceInput): Promise<MaterializedOccurrence[]>;

  /**
   * Returns occurrences for a series within a date range, filtering to the
   * latest version only.
   */
  findBySeriesId(
    seriesId: string,
    fromMs: number,
    toMs: number,
  ): Promise<MaterializedOccurrence[]>;

  /**
   * Removes occurrences with a version older than the current series version.
   */
  cleanStaleVersions(seriesId: string, currentVersion: number): Promise<number>;

  /**
   * Deletes occurrences whose date is before the given cutoff.
   */
  cleanExpired(beforeMs: number): Promise<number>;

  /**
   * Deletes all occurrences for a series. Used when a series is deleted.
   */
  deleteBySeriesId(seriesId: string): Promise<number>;
}

// ── In-memory implementation (for tests) ────────────────────────────────────

const cloneOccurrence = (o: MaterializedOccurrence): MaterializedOccurrence => ({ ...o });

let idCounter = 1;
const store: MaterializedOccurrence[] = [];

export class InMemoryMaterializedOccurrenceRepository
  implements MaterializedOccurrenceRepository
{
  async bulkUpsert(input: BulkUpsertOccurrenceInput): Promise<MaterializedOccurrence[]> {
    // Remove old occurrences for this series (reverse iteration to avoid index shifts)
    for (let i = store.length - 1; i >= 0; i--) {
      if (store[i].seriesId === input.seriesId) {
        store.splice(i, 1);
      }
    }

    const now = Date.now();
    const created: MaterializedOccurrence[] = input.occurrenceDates.map((date) => ({
      id: `occ-${idCounter++}`,
      seriesId: input.seriesId,
      seriesVersion: input.seriesVersion,
      occurrenceDate: date,
      materializedAt: input.materializedAt,
      createdAt: now,
    }));

    store.push(...created);
    return created.map(cloneOccurrence);
  }

  async findBySeriesId(
    seriesId: string,
    fromMs: number,
    toMs: number,
  ): Promise<MaterializedOccurrence[]> {
    // Find latest version for this series
    const seriesOccs = store.filter((o) => o.seriesId === seriesId);
    const latestVersion = Math.max(...seriesOccs.map((o) => o.seriesVersion), 0);

    return seriesOccs
      .filter(
        (o) =>
          o.seriesVersion === latestVersion &&
          o.occurrenceDate >= fromMs &&
          o.occurrenceDate <= toMs,
      )
      .sort((a, b) => a.occurrenceDate - b.occurrenceDate)
      .map(cloneOccurrence);
  }

  async cleanStaleVersions(seriesId: string, currentVersion: number): Promise<number> {
    let removed = 0;
    for (let i = store.length - 1; i >= 0; i--) {
      if (store[i].seriesId === seriesId && store[i].seriesVersion < currentVersion) {
        store.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async cleanExpired(beforeMs: number): Promise<number> {
    let removed = 0;
    for (let i = store.length - 1; i >= 0; i--) {
      if (store[i].occurrenceDate < beforeMs) {
        store.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  async deleteBySeriesId(seriesId: string): Promise<number> {
    let removed = 0;
    for (let i = store.length - 1; i >= 0; i--) {
      if (store[i].seriesId === seriesId) {
        store.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Resets the store — for test isolation. */
  reset(): void {
    store.splice(0, store.length);
    idCounter = 1;
  }
}

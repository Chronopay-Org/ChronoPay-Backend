/**
 * occurrenceSeriesService.ts
 *
 * Service layer for managing recurrence series with automatic invalidation.
 *
 * When a series is edited (RRULE updated), the version is bumped atomically.
 * This invalidates all pre-materialized occurrences from the previous version.
 * The materializer job will pick up the new version on its next run.
 *
 * IMPORTANT — TOCTOU awareness:
 *   The materializer job calls listAll() then processes each series individually.
 *   Between listing and processing, a series could be edited or deleted. This is
 *   acceptable for a daily batch job because:
 *     - If deleted: materializeSeries will throw "not found" and be logged.
 *     - If edited: we materialize against the current version (read at processing
 *       time), which is always correct. Old versions are cleaned by stale-cleanup.
 */

import type {
  RecurrenceSeries,
  RecurrenceSeriesRepository,
} from "../models/recurrenceSeries.js";
import type { MaterializedOccurrenceRepository } from "../models/materializedOccurrence.js";
import {
  getRecurrenceSeriesRepository,
} from "../repositories/recurrenceSeriesRepository.js";
import {
  getMaterializedOccurrenceRepository,
} from "../repositories/materializedOccurrenceRepository.js";

export interface OccurrenceSeriesServiceOptions {
  seriesRepository?: RecurrenceSeriesRepository;
  occurrenceRepository?: MaterializedOccurrenceRepository;
}

export class OccurrenceSeriesService {
  private readonly seriesRepo: RecurrenceSeriesRepository;
  private readonly occurrenceRepo: MaterializedOccurrenceRepository;

  constructor(options: OccurrenceSeriesServiceOptions = {}) {
    this.seriesRepo = options.seriesRepository ?? getRecurrenceSeriesRepository();
    this.occurrenceRepo =
      options.occurrenceRepository ?? getMaterializedOccurrenceRepository();
  }

  /**
   * Creates a new recurrence series.
   */
  async createSeries(rrule: string): Promise<RecurrenceSeries> {
    return this.seriesRepo.create({ rrule });
  }

  /**
   * Updates the RRULE of an existing series.
   *
   * IMPORTANT: This atomically bumps the series version, which invalidates all
   * previously materialized occurrences. The materializer job will re-materialize
   * with the new RRULE on its next run.
   *
   * Stale occurrences are cleaned up asynchronously — this keeps the edit
   * operation fast and avoids a potentially expensive synchronous DELETE.
   */
  async editSeries(seriesId: string, newRRule: string): Promise<RecurrenceSeries> {
    const updated = await this.seriesRepo.updateRRule(seriesId, newRRule);
    if (!updated) {
      throw new Error(`Recurrence series not found: ${seriesId}`);
    }

    // Clean stale occurrences asynchronously. Failures are not critical —
    // the materializer will clean them up on its next run.
    void this.occurrenceRepo
      .cleanStaleVersions(seriesId, updated.version)
      .catch(() => {
        // Best-effort cleanup; failures are not critical.
      });

    return updated;
  }

  /**
   * Deletes a series. The FK on materialized_occurrences has ON DELETE CASCADE,
   * so deleting the series automatically removes all materialized occurrences.
   */
  async deleteSeries(seriesId: string): Promise<void> {
    await this.seriesRepo.delete(seriesId);
  }

  /**
   * Returns the pre-materialized occurrences for a series within a date range.
   * Only returns occurrences matching the latest series version.
   */
  async getOccurrences(seriesId: string, fromMs: number, toMs: number) {
    return this.occurrenceRepo.findBySeriesId(seriesId, fromMs, toMs);
  }
}

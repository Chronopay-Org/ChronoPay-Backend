/**
 * occurrenceMaterializer.ts
 *
 * Scheduler job that pre-materializes the next HORIZON_DAYS of RRULE occurrences
 * for every active recurrence series. Runs daily (or on demand) and rolls forward
 * to maintain a flat, query-efficient materialized view.
 *
 * The rolling-horizon approach means:
 *  - Each run materializes [today, today + 90 days] per series.
 *  - Expired occurrences (before today) are cleaned up.
 *  - Stale versions (from series edits) are cleaned up.
 */

import { type RecurrenceSeriesRepository } from "../models/recurrenceSeries.js";
import { type MaterializedOccurrenceRepository } from "../models/materializedOccurrence.js";
import {
  getRecurrenceSeriesRepository,
} from "../repositories/recurrenceSeriesRepository.js";
import {
  getMaterializedOccurrenceRepository,
} from "../repositories/materializedOccurrenceRepository.js";
import { expandRRule, RecurrenceError, MAX_OCCURRENCES } from "../services/recurrenceService.js";
import { logger } from "../utils/logger.js";

/** Number of days ahead to materialize occurrences. */
export const HORIZON_DAYS = 90;

/** Maximum COUNT to use when bounding an unbounded RRULE.  Must not exceed
 *  MAX_OCCURRENCES from recurrenceService (200) to avoid triggering the
 *  expandRRule safety cap. */
const MAX_COUNT_FOR_BOUNDING = MAX_OCCURRENCES;

export interface MaterializationReport {
  seriesProcessed: number;
  seriesFailed: number;
  occurrencesMaterialized: number;
  staleCleaned: number;
  expiredCleaned: number;
  errors: string[];
}

export interface OccurrenceMaterializerOptions {
  seriesRepository?: RecurrenceSeriesRepository;
  occurrenceRepository?: MaterializedOccurrenceRepository;
  horizonDays?: number;
  now?: number;
}

/**
 * Materializes occurrences for all active series up to the configured horizon.
 * Safe to call concurrently — each series upsert is self-contained.
 */
export async function materializeAllSeries(
  options: OccurrenceMaterializerOptions = {},
): Promise<MaterializationReport> {
  const seriesRepo = options.seriesRepository ?? getRecurrenceSeriesRepository();
  const occRepo = options.occurrenceRepository ?? getMaterializedOccurrenceRepository();
  const horizonDays = options.horizonDays ?? HORIZON_DAYS;
  const now = options.now ?? Date.now();

  const report: MaterializationReport = {
    seriesProcessed: 0,
    seriesFailed: 0,
    occurrencesMaterialized: 0,
    staleCleaned: 0,
    expiredCleaned: 0,
    errors: [],
  };

  const allSeries = await seriesRepo.listAll();

  for (const series of allSeries) {
    try {
      const result = await materializeSeries(series.id, {
        seriesRepository: seriesRepo,
        occurrenceRepository: occRepo,
        horizonDays,
        now,
      });
      report.seriesProcessed++;
      report.occurrencesMaterialized += result.occurrencesMaterialized;
      report.staleCleaned += result.staleCleaned;
    } catch (err) {
      report.seriesFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`Series ${series.id}: ${msg}`);
      logger.error({ seriesId: series.id, error: msg }, "Failed to materialize series");
    }
  }

  // Clean expired occurrences (before today) across all series
  report.expiredCleaned = await occRepo.cleanExpired(now);

  if (report.seriesFailed > 0) {
    logger.warn(
      { processed: report.seriesProcessed, failed: report.seriesFailed },
      "Occurrence materialization completed with errors",
    );
  }

  return report;
}

export interface SingleMaterializationResult {
  occurrencesMaterialized: number;
  staleCleaned: number;
}

/**
 * Materializes occurrences for a single series.
 *
 * Steps:
 *  1. Read the current series (to get latest version).
 *  2. Expand the RRULE bounded to [now, now + horizonDays].
 *  3. Bulk-upsert the occurrences into materialized_occurrences.
 *  4. Clean up stale versions from previous materializations.
 */
export async function materializeSeries(
  seriesId: string,
  options: OccurrenceMaterializerOptions = {},
): Promise<SingleMaterializationResult> {
  const seriesRepo = options.seriesRepository ?? getRecurrenceSeriesRepository();
  const occRepo = options.occurrenceRepository ?? getMaterializedOccurrenceRepository();
  const horizonDays = options.horizonDays ?? HORIZON_DAYS;
  const now = options.now ?? Date.now();
  const horizonEnd = now + horizonDays * 24 * 60 * 60 * 1000;

  const series = await seriesRepo.findById(seriesId);
  if (!series) {
    throw new Error(`Recurrence series not found: ${seriesId}`);
  }

  // Expand with a bounded window — we enforce COUNT so expandRRule doesn't
  // reject an unbounded RRULE.
  const boundedRRule = ensureBoundedRRule(series.rrule, MAX_COUNT_FOR_BOUNDING);

  let allOccurrences: Date[];
  try {
    allOccurrences = expandRRule(boundedRRule);
  } catch (err) {
    if (err instanceof RecurrenceError) {
      throw err;
    }
    throw new Error(`Failed to expand RRULE for series ${seriesId}: ${String(err)}`);
  }

  // Filter to the horizon window [now, horizonEnd]
  const horizonOccurrences = allOccurrences.filter(
    (d) => d.getTime() >= now && d.getTime() <= horizonEnd,
  );

  // Bulk-upsert
  await occRepo.bulkUpsert({
    seriesId: series.id,
    seriesVersion: series.version,
    occurrenceDates: horizonOccurrences.map((d) => d.getTime()),
    materializedAt: now,
  });

  // Clean stale versions
  const staleCleaned = await occRepo.cleanStaleVersions(series.id, series.version);

  return {
    occurrencesMaterialized: horizonOccurrences.length,
    staleCleaned,
  };
}

/**
 * Ensures an RRULE string has a COUNT clause so it is bounded.
 * Used internally to safely expand RRULEs within the materialization window.
 *
 * We add a high COUNT so occurrences beyond the horizon are still generated
 * (they'll be filtered out by the date range), but the RRULE is never unbounded.
 */
function ensureBoundedRRule(rrule: string, maxCount: number): string {
  const upperRRule = rrule.toUpperCase();
  const hasCount = upperRRule.includes("COUNT=");
  const hasUntil = upperRRule.includes("UNTIL=");

  if (hasCount || hasUntil) {
    return rrule; // Already bounded
  }

  // Add COUNT to make it bounded
  const trimmed = rrule.trimEnd();
  return `${trimmed};COUNT=${maxCount}`;
}

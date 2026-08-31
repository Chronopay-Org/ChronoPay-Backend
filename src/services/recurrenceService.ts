// @ts-nocheck
// rrule is a CJS module; import the default export and destructure for
// compatibility with Jest's --experimental-vm-modules ESM test environment.
// Actual interop varies by consumer, so resolve through `.default` when
// present (`import * as` only exposes `default`/`rrule` under Node's
// CJS-ESM bridge for rrule 2.8.x).
import * as rruleLib from "rrule";
import type { RRule as RRuleType } from "rrule";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";
import { SupplierTimezoneContext } from "../modules/slots/slot-repository.js";
import {
  TimezoneResolverService,
  createInMemoryTimezoneResolverDeps,
} from "./timezoneResolverService.js";
const rruleCjs = (rruleLib as any).default ?? rruleLib;
const { RRule: _RRule, rrulestr } = rruleCjs as {
  RRule: typeof RRuleType;
  rrulestr: (rruleStr: string, options?: Record<string, unknown>) => RRuleType;
};

export const MAX_OCCURRENCES = 200;

/** Maximum number of EXDATE entries allowed in a single rule string. */
export const MAX_EXDATES = 100;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

/**
 * A blackout window: any RRULE occurrence that falls within [startMs, endMs]
 * (inclusive) is suppressed from the final expansion.
 */
export interface BlackoutWindow {
  /** Inclusive start of the blackout period in epoch milliseconds. */
  startMs: number;
  /** Inclusive end of the blackout period in epoch milliseconds. */
  endMs: number;
  /** Optional human-readable label (e.g., "Company shutdown Q4"). */
  label?: string;
}

/**
 * Result of {@link expandRRuleWithExdate}, detailing which occurrences were
 * removed and why.
 */
export interface ExpandRRuleResult {
  /** Occurrences remaining after all exclusions (EXDATE + blackouts). */
  occurrences: Date[];
  /** Dates excluded by EXDATE directives (at day granularity, UTC). */
  excludedByExdate: Date[];
  /** Dates excluded by blackout windows. */
  excludedByBlackout: Date[];
}

// ─── EXDATE parsing ───────────────────────────────────────────────────────────

/**
 * Extract EXDATE values from an iCalendar text block.
 *
 * Supports:
 *  - `EXDATE:20260101T000000Z,20260201T000000Z`  (comma-separated UTC)
 *  - `EXDATE;TZID=America/New_York:20260101T090000` (TZID parameter)
 *  - Multiple EXDATE lines
 *  - DATE-only values: `EXDATE:20260101`
 *
 * Returns an array of UTC Date objects normalised to midnight UTC of the
 * excluded day (so the comparison in {@link expandRRuleWithExdate} only
 * needs day-level equality regardless of the time component in the rule).
 *
 * @throws RecurrenceError if the value list exceeds MAX_EXDATES.
 */
export function parseExdates(rruleText: string): Date[] {
  const exdates: Date[] = [];

  // Each EXDATE property may contain multiple comma-separated values.
  // Pattern: EXDATE[;param=value]*:<value-list>
  const exdateLineRegex = /^EXDATE(?:;[^:]*)?:(.+)$/gim;
  let match: RegExpExecArray | null;

  while ((match = exdateLineRegex.exec(rruleText)) !== null) {
    const valueList = match[1].trim();
    const values = valueList.split(",").map((v) => v.trim()).filter(Boolean);
    for (const val of values) {
      const d = parseSingleExdate(val);
      if (d) exdates.push(d);
    }
  }

  if (exdates.length > MAX_EXDATES) {
    throw new RecurrenceError(
      `EXDATE list exceeds maximum of ${MAX_EXDATES} entries`,
    );
  }

  return exdates;
}

/**
 * Parse a single iCalendar date-time value (e.g., `20260701T120000Z`,
 * `20260701T120000`, `20260701`) into a UTC Date at midnight of that day.
 * Returns null for unrecognised formats so the caller can skip them.
 */
function parseSingleExdate(value: string): Date | null {
  // Strip any trailing 'Z' for normalisation; we always treat as day-level.
  const v = value.replace(/Z$/i, "").trim();
  // DATE-TIME: YYYYMMDDTHHMMSS
  const dtMatch = v.match(/^(\d{4})(\d{2})(\d{2})T\d{6}/);
  // DATE: YYYYMMDD
  const dateMatch = v.match(/^(\d{4})(\d{2})(\d{2})$/);

  const m = dtMatch ?? dateMatch;
  if (!m) return null;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1; // 0-indexed
  const day = parseInt(m[3], 10);

  // Normalise to midnight UTC so we can compare at day granularity.
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
}

/**
 * Returns true when two dates represent the same UTC calendar day.
 */
function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// ─── Core expansion ───────────────────────────────────────────────────────────

/**
 * Expand an iCalendar RRULE string into concrete occurrences, applying both
 * EXDATE exclusions (parsed from the text) and explicit blackout windows.
 *
 * Blackouts and EXDATEs are additive: an occurrence is excluded if it falls
 * within *either* an EXDATE or *any* overlapping blackout window.
 *
 * @param rruleText  Full iCalendar text; may include DTSTART, RRULE, EXDATE lines.
 * @param blackouts  Optional array of blackout windows.
 * @returns          {@link ExpandRRuleResult} with separated exclusion sets.
 *
 * @throws RecurrenceError for invalid/unbounded rules or oversized EXDATE lists.
 */
export function expandRRuleWithExdate(
  rruleText: string,
  blackouts: BlackoutWindow[] = [],
): ExpandRRuleResult {
  if (typeof rruleText !== "string" || rruleText.trim().length === 0) {
    throw new RecurrenceError("rrule must be a non-empty string");
  }

  // Parse EXDATE lines before we pass the text to rrulestr (rrule.js ignores
  // unknown lines, so we extract them ourselves).
  const exdates = parseExdates(rruleText);

  // Build a version of the text without EXDATE lines so that rrulestr
  // processes only the RRULE/DTSTART/RDATE content.
  const rruleOnly = rruleText
    .split(/\r?\n/)
    .filter((line) => !/^EXDATE/i.test(line.trim()))
    .join("\n");

  let rule: RRuleType;
  try {
    rule = rrulestr(rruleOnly, { forceset: false }) as unknown as RRuleType;
  } catch {
    throw new RecurrenceError("Invalid RRULE format");
  }

  const options = (rule as any).options;
  if ((options.count ?? 0) <= 0 && !options.until) {
    throw new RecurrenceError("Unbounded RRULE is not allowed; include COUNT or UNTIL");
  }
  if (options.interval !== undefined && options.interval < 1 || /(?:^|[;\n])INTERVAL=-?[0]+(?:;|$)/i.test(rruleText)) {
    throw new RecurrenceError("INTERVAL must be a positive integer");
  }

  const rawOccurrences: Date[] = (rule as any).all(
    (_occ: Date, i: number) => i < MAX_OCCURRENCES + 1,
  );
  if (rawOccurrences.length > MAX_OCCURRENCES) {
    throw new RecurrenceError(
      `RRULE expands to more than ${MAX_OCCURRENCES} occurrences`,
    );
  }

  const excludedByExdate: Date[] = [];
  const excludedByBlackout: Date[] = [];
  const occurrences: Date[] = [];

  for (const occ of rawOccurrences) {
    const occMs = occ.getTime();

    // EXDATE check (day-level UTC comparison)
    if (exdates.some((ex) => sameUtcDay(ex, occ))) {
      excludedByExdate.push(occ);
      continue;
    }

    // Blackout check (ms-level range comparison)
    const inBlackout = blackouts.some((b) => occMs >= b.startMs && occMs <= b.endMs);
    if (inBlackout) {
      excludedByBlackout.push(occ);
      continue;
    }

    occurrences.push(occ);
  }

  return { occurrences, excludedByExdate, excludedByBlackout };
}

/**
 * Backward-compatible wrapper around {@link expandRRuleWithExdate}.
 *
 * If the input text contains EXDATE lines they are silently applied, so
 * existing callers that do not need the detailed exclusion report can continue
 * to use this function unchanged.
 *
 * @param rruleText  iCalendar text (may include EXDATE lines).
 * @param _dtstartIso  Unused; retained for API compatibility.
 */
export function expandRRule(rruleText: string, _dtstartIso?: string): Date[] {
  return expandRRuleWithExdate(rruleText).occurrences;
}

export interface RegionalHoliday {
  date: string;
  name: string;
  regionCodes: string[];
  observanceType: "full_day" | "half_day" | "morning" | "afternoon" | "bank_holiday";
  isSuppressedByDefault?: boolean;
  notes?: string;
}

export interface HolidayImpact {
  occurrence: {
    dateIso: string;
    timestampMs: number;
  };
  holiday: RegionalHoliday;
  affectedRegionCodes: string[];
  resolutionHint: "suppress" | "flag_only" | "adjust_hours";
}

export interface HolidayImpactAnalysis {
  totalOccurrences: number;
  affectedOccurrences: number;
  impactedOccurrences: HolidayImpact[];
  uniqueRegionCodes: string[];
  uniqueHolidayNames: string[];
  summary: string;
  analysisGeneratedAt: string;
  scope: {
    supplierId?: string;
    storeId?: string;
    regionCodesScoped: string[];
  };
}

export interface HolidayRegistry {
  listHolidaysInRange(startMs: number, endMs: number, regionCodes?: string[]): Promise<RegionalHoliday[]>;
  listHolidaysInRangeSync(startMs: number, endMs: number, regionCodes?: string[]): RegionalHoliday[];
}

export function createInMemoryHolidayRegistry(seed: RegionalHoliday[] = []): HolidayRegistry {
  const holidays = [...seed];
  const matchesRegion = (h: RegionalHoliday, filter: string[] | undefined): boolean => {
    if (!filter || filter.length === 0) return true;
    return h.regionCodes.some((r) => filter.includes(r));
  };
  const inRange = (h: RegionalHoliday, startMs: number, endMs: number): boolean => {
    const dayMs = new Date(h.date + "T00:00:00Z").getTime();
    const dayEndMs = dayMs + 24 * 60 * 60 * 1000 - 1;
    return dayEndMs >= startMs && dayMs <= endMs;
  };
  const query = (startMs: number, endMs: number, regionCodes?: string[]) =>
    holidays
      .filter((h) => inRange(h, startMs, endMs))
      .filter((h) => matchesRegion(h, regionCodes));
  return {
    listHolidaysInRange: async (s, e, r) => query(s, e, r),
    listHolidaysInRangeSync: (s, e, r) => query(s, e, r),
  };
}

function sameDayIso(aIso: string, occurrenceMs: number, resolvedTimezone: string): boolean {
  const aDate = new Date(aIso + "T00:00:00Z");
  const aDay = formatDateInTimezone(aDate.getTime(), resolvedTimezone);
  const oDay = formatDateInTimezone(occurrenceMs, resolvedTimezone);
  return aDay === oDay;
}

function formatDateInTimezone(epochMs: number, ianaTimezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: ianaTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(epochMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const d = new Date(epochMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
}

function pickResolutionHint(holiday: RegionalHoliday): HolidayImpact["resolutionHint"] {
  if (holiday.isSuppressedByDefault) return "suppress";
  if (holiday.observanceType === "bank_holiday") return "suppress";
  if (holiday.observanceType === "half_day" || holiday.observanceType === "morning" || holiday.observanceType === "afternoon") {
    return "adjust_hours";
  }
  return "flag_only";
}

export interface HolidayImpactAnalyzerDeps {
  holidayRegistry?: HolidayRegistry;
  auditLogger?: AuditLogger;
  getSupplierContext?: (supplierId: string) => Promise<SupplierTimezoneContext | undefined>;
  timezoneResolver?: TimezoneResolverService;
  nowIso?: () => string;
}

export class HolidayImpactAnalyzer {
  private readonly holidayRegistry: HolidayRegistry;
  private readonly auditLogger: AuditLogger;
  private readonly getSupplierContext: (supplierId: string) => Promise<SupplierTimezoneContext | undefined>;
  private readonly timezoneResolver: TimezoneResolverService;
  private readonly nowIso: () => string;

  constructor(deps: HolidayImpactAnalyzerDeps = {}) {
    this.holidayRegistry = deps.holidayRegistry ?? createInMemoryHolidayRegistry();
    this.auditLogger = deps.auditLogger ?? defaultAuditLogger;
    const tzDeps = createInMemoryTimezoneResolverDeps({ auditLogger: this.auditLogger });
    this.getSupplierContext = deps.getSupplierContext ?? tzDeps.getSupplierContext;
    this.timezoneResolver =
      deps.timezoneResolver ?? new TimezoneResolverService(tzDeps);
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
  }

  async analyze(params: {
    rruleText: string;
    supplierId?: string;
    storeId?: string;
    tenantId?: string;
    scopedRegionCodes?: string[];
    actorId?: string;
    /** Optional blackout windows to suppress from the expansion (stacks with EXDATE). */
    blackouts?: BlackoutWindow[];
  }): Promise<HolidayImpactAnalysis> {
    const { rruleText, supplierId, storeId, tenantId, scopedRegionCodes, actorId, blackouts } = params;

    const occurrences = expandRRuleWithExdate(rruleText, blackouts ?? []).occurrences;
    if (occurrences.length === 0) {
      return this.emptyAnalysis(supplierId, storeId, scopedRegionCodes);
    }

    const startMs = occurrences[0].getTime();
    const endMs = occurrences[occurrences.length - 1].getTime();

    let effectiveRegions: string[] = [];
    let resolvedTimezone = "UTC";

    if (supplierId) {
      const supplierCtx = await this.getSupplierContext(supplierId);
      if (supplierCtx) {
        const directStoreRegions = this.timezoneResolver.getRegionsForStore({
          supplierContext: supplierCtx,
          storeId,
        });
        const supplierAllRegions = this.timezoneResolver.getAllRegionsForSupplier(supplierCtx);
        const baseRegions = (storeId ? directStoreRegions : supplierAllRegions) || [];
        effectiveRegions = baseRegions;

        if (tenantId) {
          try {
            const tzResult = await this.timezoneResolver.resolveTimezone({
              supplierId,
              tenantId,
              storeId,
              actorId,
            });
            resolvedTimezone = tzResult.timezone;
          } catch {
            resolvedTimezone = "UTC";
          }
        }
      }
    }

    if (scopedRegionCodes && scopedRegionCodes.length > 0) {
      effectiveRegions =
        effectiveRegions.length > 0
          ? effectiveRegions.filter((r) => scopedRegionCodes.includes(r))
          : scopedRegionCodes;
    }

    const holidays = await this.holidayRegistry.listHolidaysInRange(
      startMs,
      endMs,
      effectiveRegions.length > 0 ? effectiveRegions : undefined,
    );

    const impacts: HolidayImpact[] = [];
    const uniqueRegions = new Set<string>();
    const uniqueHolidays = new Set<string>();

    for (const occ of occurrences) {
      const occMs = occ.getTime();
      for (const holiday of holidays) {
        const affectedRegions =
          effectiveRegions.length > 0
            ? holiday.regionCodes.filter((r) => effectiveRegions.includes(r))
            : holiday.regionCodes;
        if (affectedRegions.length === 0) continue;
        if (!sameDayIso(holiday.date, occMs, resolvedTimezone)) continue;

        for (const r of affectedRegions) uniqueRegions.add(r);
        uniqueHolidays.add(holiday.name);

        impacts.push({
          occurrence: {
            dateIso: formatDateInTimezone(occMs, resolvedTimezone),
            timestampMs: occMs,
          },
          holiday,
          affectedRegionCodes: affectedRegions,
          resolutionHint: pickResolutionHint(holiday),
        });
      }
    }

    const uniqueRegionCodes = Array.from(uniqueRegions).sort();
    const uniqueHolidayNames = Array.from(uniqueHolidays).sort();
    const summary = this.buildSummary(
      occurrences.length,
      impacts.length,
      uniqueHolidayNames,
      uniqueRegionCodes,
    );

    const analysis: HolidayImpactAnalysis = {
      totalOccurrences: occurrences.length,
      affectedOccurrences: impacts.length,
      impactedOccurrences: impacts,
      uniqueRegionCodes,
      uniqueHolidayNames,
      summary,
      analysisGeneratedAt: this.nowIso(),
      scope: {
        supplierId,
        storeId,
        regionCodesScoped: effectiveRegions,
      },
    };

    await this.auditLogger.log("recurrence.holiday_impact_analyzed", {
      context: {
        supplierId,
        storeId,
        totalOccurrences: analysis.totalOccurrences,
        affectedOccurrences: analysis.affectedOccurrences,
        uniqueHolidayNames,
        uniqueRegionCodes,
      },
      userId: actorId,
    }, {
      resource: supplierId ? `supplier:${supplierId}${storeId ? `:store:${storeId}` : ""}` : "recurrence-analysis",
      status: 200,
    });

    return analysis;
  }

  analyzeSync(params: {
    rruleText: string;
    supplierContext?: SupplierTimezoneContext;
    storeId?: string;
    resolvedTimezone?: string;
    scopedRegionCodes?: string[];
    holidays: RegionalHoliday[];
    /** Optional blackout windows to suppress from the expansion (stacks with EXDATE). */
    blackouts?: BlackoutWindow[];
  }): HolidayImpactAnalysis {
    const { rruleText, supplierContext, storeId, resolvedTimezone, scopedRegionCodes, holidays, blackouts } = params;

    const occurrences = expandRRuleWithExdate(rruleText, blackouts ?? []).occurrences;
    if (occurrences.length === 0) {
      return this.emptyAnalysis(
        supplierContext?.supplierId,
        storeId,
        scopedRegionCodes,
      );
    }

    const startMs = occurrences[0].getTime();
    const endMs = occurrences[occurrences.length - 1].getTime();

    const tz = resolvedTimezone ?? "UTC";
    const directStoreRegions = this.timezoneResolver.getRegionsForStore({
      supplierContext,
      storeId,
    });
    const supplierAllRegions = this.timezoneResolver.getAllRegionsForSupplier(supplierContext);
    let effectiveRegions = (storeId ? directStoreRegions : supplierAllRegions) || [];
    if (scopedRegionCodes && scopedRegionCodes.length > 0) {
      effectiveRegions =
        effectiveRegions.length > 0
          ? effectiveRegions.filter((r) => scopedRegionCodes.includes(r))
          : scopedRegionCodes;
    }

    const rangeHolidays = holidays.filter((h) => {
      const dayMs = new Date(h.date + "T00:00:00Z").getTime();
      const dayEndMs = dayMs + 24 * 60 * 60 * 1000 - 1;
      return dayEndMs >= startMs && dayMs <= endMs;
    });

    const impacts: HolidayImpact[] = [];
    const uniqueRegions = new Set<string>();
    const uniqueHolidays = new Set<string>();

    for (const occ of occurrences) {
      const occMs = occ.getTime();
      for (const holiday of rangeHolidays) {
        const affectedRegions =
          effectiveRegions.length > 0
            ? holiday.regionCodes.filter((r) => effectiveRegions.includes(r))
            : holiday.regionCodes;
        if (affectedRegions.length === 0) continue;
        if (!sameDayIso(holiday.date, occMs, tz)) continue;

        for (const r of affectedRegions) uniqueRegions.add(r);
        uniqueHolidays.add(holiday.name);

        impacts.push({
          occurrence: {
            dateIso: formatDateInTimezone(occMs, tz),
            timestampMs: occMs,
          },
          holiday,
          affectedRegionCodes: affectedRegions,
          resolutionHint: pickResolutionHint(holiday),
        });
      }
    }

    const uniqueRegionCodes = Array.from(uniqueRegions).sort();
    const uniqueHolidayNames = Array.from(uniqueHolidays).sort();
    const summary = this.buildSummary(
      occurrences.length,
      impacts.length,
      uniqueHolidayNames,
      uniqueRegionCodes,
    );

    return {
      totalOccurrences: occurrences.length,
      affectedOccurrences: impacts.length,
      impactedOccurrences: impacts,
      uniqueRegionCodes,
      uniqueHolidayNames,
      summary,
      analysisGeneratedAt: this.nowIso(),
      scope: {
        supplierId: supplierContext?.supplierId,
        storeId,
        regionCodesScoped: effectiveRegions,
      },
    };
  }

  private emptyAnalysis(
    supplierId?: string,
    storeId?: string,
    scopedRegionCodes?: string[],
  ): HolidayImpactAnalysis {
    return {
      totalOccurrences: 0,
      affectedOccurrences: 0,
      impactedOccurrences: [],
      uniqueRegionCodes: [],
      uniqueHolidayNames: [],
      summary: "No occurrences generated by the RRULE.",
      analysisGeneratedAt: this.nowIso(),
      scope: {
        supplierId,
        storeId,
        regionCodesScoped: scopedRegionCodes ?? [],
      },
    };
  }

  private buildSummary(
    total: number,
    affected: number,
    holidayNames: string[],
    regionCodes: string[],
  ): string {
    if (total === 0) return "No occurrences generated by the RRULE.";
    if (affected === 0) return `All ${total} occurrence(s) are clear of regional holidays in the scoped regions.`;
    const pct = Math.round((affected / total) * 100);
    const holidayStr = holidayNames.length > 0 ? ` (${holidayNames.join(", ")})` : "";
    const regionStr = regionCodes.length > 0 ? ` in ${regionCodes.length} region(s)` : "";
    return `${affected} of ${total} occurrence(s) (${pct}%) intersect${holidayStr.length > 1 ? "" : "s"} with${holidayStr}${regionStr}.`;
  }
}

export function groupImpactsByHoliday(analysis: HolidayImpactAnalysis): Record<string, HolidayImpact[]> {
  const grouped: Record<string, HolidayImpact[]> = {};
  for (const impact of analysis.impactedOccurrences) {
    const key = impact.holiday.name;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(impact);
  }
  return grouped;
}

export function groupImpactsByDate(analysis: HolidayImpactAnalysis): Record<string, HolidayImpact[]> {
  const grouped: Record<string, HolidayImpact[]> = {};
  for (const impact of analysis.impactedOccurrences) {
    const key = impact.occurrence.dateIso;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(impact);
  }
  return grouped;
}

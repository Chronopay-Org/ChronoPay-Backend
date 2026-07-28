// @ts-nocheck
// rrule is a CJS module; import the default export and destructure for
// compatibility with Jest's --experimental-vm-modules ESM test environment.
import type { RRule as RRuleType } from "rrule";
import rruleLib from "rrule";
import { AuditLogger, defaultAuditLogger } from "./auditLogger.js";
import { SupplierTimezoneContext } from "../modules/slots/slot-repository.js";
import {
  TimezoneResolverService,
  createInMemoryTimezoneResolverDeps,
} from "./timezoneResolverService.js";
const { RRule: _RRule, rrulestr } = rruleLib as any as {
  RRule: typeof RRuleType;
  rrulestr: (rruleStr: string, options?: Record<string, unknown>) => RRuleType;
};

export const MAX_OCCURRENCES = 200;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

export function expandRRule(rruleText: string, _dtstartIso?: string): Date[] {
  if (typeof rruleText !== "string" || rruleText.trim().length === 0) {
    throw new RecurrenceError("rrule must be a non-empty string");
  }

  let rule: RRuleType;
  try {
    rule = rrulestr(rruleText, { forceset: false }) as unknown as RRule;
  } catch {
    throw new RecurrenceError("Invalid RRULE format");
  }

  const options = rule.options;
  if ((options.count ?? 0) <= 0 && !options.until) {
    throw new RecurrenceError("Unbounded RRULE is not allowed; include COUNT or UNTIL");
  }

  const occurrences: Date[] = rule.all((_occurrence: Date, i: number) => i < MAX_OCCURRENCES + 1);
  if (occurrences.length > MAX_OCCURRENCES) {
    throw new RecurrenceError(`RRULE expands to more than ${MAX_OCCURRENCES} occurrences`);
  }

  return occurrences;
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
  }): Promise<HolidayImpactAnalysis> {
    const { rruleText, supplierId, storeId, tenantId, scopedRegionCodes, actorId } = params;

    const occurrences = expandRRule(rruleText);
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
  }): HolidayImpactAnalysis {
    const { rruleText, supplierContext, storeId, resolvedTimezone, scopedRegionCodes, holidays } = params;

    const occurrences = expandRRule(rruleText);
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

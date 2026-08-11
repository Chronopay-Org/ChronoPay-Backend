import { describe, it, expect, jest } from "@jest/globals";
import {
  expandRRule,
  HolidayImpactAnalyzer,
  createInMemoryHolidayRegistry,
  RegionalHoliday,
  groupImpactsByHoliday,
  groupImpactsByDate,
} from "../recurrenceService.js";
import type { SupplierTimezoneContext } from "../../modules/slots/slot-repository.js";
import { AuditLogger } from "../auditLogger.js";

const JAN_1 = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
// rrule expects the compact YYYYMMDDTHHMMSS format in DTSTART — strip the
// dashes too, otherwise rrule rejects the DTSTART value.
const JAN_1_ISO = JAN_1.toISOString().replace(/[-:.]/g, "").slice(0, 15);

const HOLIDAYS: RegionalHoliday[] = [
  {
    date: "2026-01-01",
    name: "New Year's Day",
    regionCodes: ["US-NY", "US-CA", "US-TX", "GB-ENG"],
    observanceType: "bank_holiday",
    isSuppressedByDefault: true,
  },
  {
    date: "2026-07-04",
    name: "Independence Day",
    regionCodes: ["US-NY", "US-CA", "US-TX"],
    observanceType: "bank_holiday",
    isSuppressedByDefault: true,
  },
  {
    date: "2026-11-26",
    name: "Thanksgiving",
    regionCodes: ["US-NY", "US-CA", "US-TX"],
    observanceType: "full_day",
    isSuppressedByDefault: true,
  },
  {
    date: "2026-05-31",
    name: "Spring Bank Holiday",
    regionCodes: ["GB-ENG"],
    observanceType: "bank_holiday",
  },
  {
    date: "2026-02-14",
    name: "Valentine's Day",
    regionCodes: ["US-NY"],
    observanceType: "half_day",
    isSuppressedByDefault: false,
  },
  {
    date: "2026-03-17",
    name: "St Patrick's Day",
    regionCodes: ["IE-D"],
    observanceType: "full_day",
  },
];

function makeAuditLogger() {
  return {
    log: (jest.fn() as any).mockResolvedValue(undefined),
  } as unknown as AuditLogger;
}

function makeSupplier(regionsByStore: Record<string, string[]>): SupplierTimezoneContext {
  const stores: SupplierTimezoneContext["stores"] = {};
  for (const [storeId, regionCodes] of Object.entries(regionsByStore)) {
    stores[storeId] = { storeId, regionCodes };
  }
  return { supplierId: "supplier-1", stores };
}

function makeAnalyzer(auditLogger?: AuditLogger) {
  return new HolidayImpactAnalyzer({
    holidayRegistry: createInMemoryHolidayRegistry(HOLIDAYS),
    auditLogger: auditLogger ?? makeAuditLogger(),
  });
}

describe("expandRRule smoke tests", () => {
  it("rejects unbounded rrule", () => {
    expect(() => expandRRule("FREQ=WEEKLY;BYDAY=MO")).toThrow();
  });

  it("expands bounded rrule", () => {
    const rrule = `DTSTART:${JAN_1_ISO}Z\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TH`;
    const occ = expandRRule(rrule);
    expect(occ.length).toBe(4);
  });
});

describe("HolidayImpactAnalyzer.analyzeSync scoping to supplier region set", () => {
  it("US supplier: weekly Thursdays in 2026 hits Thanksgiving once", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=52;BYDAY=TH`;

    const supplier = makeSupplier({
      "store-nyc": ["US-NY"],
    });

    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "store-nyc",
      resolvedTimezone: "America/New_York",
      holidays: HOLIDAYS,
    });

    expect(result.totalOccurrences).toBe(52);
    expect(result.uniqueHolidayNames).toContain("Thanksgiving");
    expect(result.scope.regionCodesScoped).toEqual(["US-NY"]);

    const thanksgiving = result.impactedOccurrences.find(
      (i) => i.holiday.name === "Thanksgiving",
    );
    expect(thanksgiving).toBeTruthy();
    expect(thanksgiving!.affectedRegionCodes).toContain("US-NY");
  });

  it("GB supplier: weekly Mondays in May 2026 hits Spring Bank Holiday", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 4, 4, 9, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=5;BYDAY=MO`;

    const supplier = makeSupplier({
      "store-london": ["GB-ENG"],
    });

    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "store-london",
      resolvedTimezone: "Europe/London",
      holidays: HOLIDAYS,
    });

    expect(result.uniqueHolidayNames).toContain("Spring Bank Holiday");
    expect(result.scope.regionCodesScoped).toEqual(["GB-ENG"]);
  });

  it("scope narrows when explicit scopedRegionCodes restricts supplier regions", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=12;BYDAY=SA`;

    const supplier = makeSupplier({
      a: ["US-NY", "IE-D"],
    });

    const unrestricted = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      holidays: HOLIDAYS,
    });

    const irishOnly = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      scopedRegionCodes: ["IE-D"],
      holidays: HOLIDAYS,
    });

    expect(unrestricted.scope.regionCodesScoped.sort()).toEqual(["IE-D", "US-NY"]);
    expect(irishOnly.scope.regionCodesScoped).toEqual(["IE-D"]);
    const hasPaddys = irishOnly.uniqueHolidayNames.includes("St Patrick's Day");
    const hasNewYears = unrestricted.uniqueHolidayNames.includes("New Year's Day");
    expect(hasNewYears || hasPaddys).toBe(true);
  });

  it("Valentine's Day half_day triggers adjust_hours hint, not suppress", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 1, 1, 14, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=10;BYDAY=SA`;

    const supplier = makeSupplier({
      romantic: ["US-NY"],
    });

    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "romantic",
      holidays: HOLIDAYS,
    });

    const vday = result.impactedOccurrences.find((i) => i.holiday.name === "Valentine's Day");
    expect(vday).toBeTruthy();
    expect(vday!.resolutionHint).toBe("adjust_hours");
    expect(vday!.holiday.observanceType).toBe("half_day");
  });

  it("bank_holiday observanceType triggers suppress hint", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=12`;

    const supplier = makeSupplier({ s: ["US-NY"] });
    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "s",
      holidays: HOLIDAYS,
    });

    const newYears = result.impactedOccurrences.find(
      (i) => i.holiday.name === "New Year's Day",
    );
    expect(newYears).toBeTruthy();
    expect(newYears!.resolutionHint).toBe("suppress");
    expect(newYears!.holiday.observanceType).toBe("bank_holiday");
  });

  it("no supplier context and no explicit scope: scans all registered regions", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=YEARLY;COUNT=10`;

    const result = analyzer.analyzeSync({
      rruleText: rrule,
      holidays: HOLIDAYS,
    });

    expect(result.scope.regionCodesScoped).toEqual([]);
    expect(result.affectedOccurrences).toBeGreaterThanOrEqual(1);
  });

  it("summary string reflects counts when affected > 0", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=4;COUNT=12`;

    const supplier = makeSupplier({ s: ["US-CA"] });
    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "s",
      holidays: HOLIDAYS,
    });

    expect(result.summary).toMatch(/of 12 occurrence/);
    if (result.affectedOccurrences > 0) {
      expect(result.summary).toContain("Independence Day");
    }
  });

  it("summary string reports clear when no holidays intersect", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 5, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO`;

    const supplier = makeSupplier({ s: ["US-CA"] });
    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "s",
      holidays: HOLIDAYS,
    });

    expect(result.affectedOccurrences).toBe(0);
    expect(result.summary).toContain("clear of regional holidays");
  });
});

describe("HolidayImpactAnalyzer.analyze async path audits", () => {
  it("emits audit event with counts", async () => {
    const logger = makeAuditLogger();
    const analyzer = makeAnalyzer(logger);

    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TH`;

    const result = await analyzer.analyze({
      rruleText: rrule,
      scopedRegionCodes: ["US-NY"],
      actorId: "supplier-admin-1",
    });

    expect(result.totalOccurrences).toBe(4);
    expect(logger.log).toHaveBeenCalledWith(
      "recurrence.holiday_impact_analyzed",
      expect.objectContaining({
        context: expect.objectContaining({
          totalOccurrences: 4,
        }),
        userId: "supplier-admin-1",
      }),
      expect.anything(),
    );
  });
});

describe("grouping helpers", () => {
  it("groupImpactsByHoliday groups impacts under holiday name keys", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=24`;

    const supplier = makeSupplier({ s: ["US-NY"] });
    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "s",
      holidays: HOLIDAYS,
    });

    const grouped = groupImpactsByHoliday(result);
    for (const name of Object.keys(grouped)) {
      for (const impact of grouped[name]) {
        expect(impact.holiday.name).toBe(name);
      }
    }
  });

  it("groupImpactsByDate groups impacts under date keys", () => {
    const analyzer = makeAnalyzer();
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=52;BYDAY=TH`;

    const supplier = makeSupplier({ s: ["US-NY"] });
    const result = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "s",
      holidays: HOLIDAYS,
    });

    const grouped = groupImpactsByDate(result);
    for (const date of Object.keys(grouped)) {
      for (const impact of grouped[date]) {
        expect(impact.occurrence.dateIso).toBe(date);
      }
    }
  });
});

describe("region codes extracted correctly for store vs supplier-wide", () => {
  it("store-level scope returns only that store's region codes", () => {
    const analyzer = makeAnalyzer();
    const supplier = makeSupplier({
      east: ["US-NY", "US-MA"],
      west: ["US-CA", "US-OR"],
    });
    const dtstart = new Date(Date.UTC(2026, 0, 1, 10, 0, 0));
    const dtstartStr = dtstart.toISOString().replace(/[-:.]/g, "").slice(0, 15);
    const rrule = `DTSTART:${dtstartStr}Z\nRRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO`;

    const eastOnly = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      storeId: "east",
      holidays: HOLIDAYS,
    });
    expect(eastOnly.scope.regionCodesScoped.sort()).toEqual(["US-MA", "US-NY"]);

    const supplierWide = analyzer.analyzeSync({
      rruleText: rrule,
      supplierContext: supplier,
      holidays: HOLIDAYS,
    });
    expect(supplierWide.scope.regionCodesScoped.sort()).toEqual([
      "US-CA",
      "US-MA",
      "US-NY",
      "US-OR",
    ]);
  });
});

// @ts-nocheck
/**
 * Holiday Calendar Admin API — integration + unit tests
 *
 * Strategy:
 *  - Routes: supertest against createApp(); repo injected via
 *    setHolidayCalendarRepository() so no DB is needed.
 *  - Service / overlap logic: pure unit tests against
 *    HolidayCalendarService + InMemoryHolidayCalendarRepository.
 *
 * Coverage targets (≥95%):
 *  - All 11 HTTP endpoints (happy paths + error branches)
 *  - Auth guard (missing / wrong token → 401/403)
 *  - Validation errors (missing fields, bad dates, overlaps)
 *  - YAML import: valid, schema-invalid, overlapping, duplicate region (replace)
 *  - Revision history: list, fetch specific version
 *  - Rollback: restores entries + saves new revision
 *  - detectEntryOverlaps helper
 *  - Named error classes
 */

import request from "supertest";
import { createApp } from "../../app.js";
import {
  setHolidayCalendarRepository,
} from "../../routes/admin.js";
import {
  InMemoryHolidayCalendarRepository,
  HolidayCalendarService,
  HolidayCalendarNotFoundError,
  HolidayCalendarConflictError,
  HolidayCalendarValidationError,
  detectEntryOverlaps,
} from "../../services/holidayCalendarService.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ADMIN_TOKEN = "test-admin-token";
const ADMIN_HDR = { "x-chronopay-admin-token": ADMIN_TOKEN };
const BASE = "/api/v1/admin/holiday-calendars";

const VALID_CALENDAR = { region: "us-east", name: "US East Holidays" };

const VALID_ENTRY = {
  name: "New Year",
  start_date: "2025-01-01",
  end_date: "2025-01-01",
  recurring: true,
};

const VALID_YAML_PAYLOAD = {
  region: "eu-west",
  name: "EU West Holidays",
  holidays: [
    { name: "Christmas", start_date: "2025-12-25", end_date: "2025-12-26" },
    { name: "New Year", start_date: "2025-01-01", end_date: "2025-01-01" },
  ],
};

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;
let repo: InMemoryHolidayCalendarRepository;

beforeEach(() => {
  process.env.CHRONOPAY_ADMIN_TOKEN = ADMIN_TOKEN;
  repo = new InMemoryHolidayCalendarRepository();
  setHolidayCalendarRepository(repo);
  app = createApp({ enableContentNegotiation: false });
});

afterEach(() => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
  repo.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH GUARD
// ═══════════════════════════════════════════════════════════════════════════════

describe("Auth guard — all holiday-calendar endpoints", () => {
  const endpoints = [
    { method: "get",    path: BASE },
    { method: "post",   path: BASE },
    { method: "get",    path: `${BASE}/some-id` },
    { method: "patch",  path: `${BASE}/some-id` },
    { method: "delete", path: `${BASE}/some-id` },
    { method: "post",   path: `${BASE}/some-id/entries` },
    { method: "delete", path: `${BASE}/some-id/entries/entry-id` },
    { method: "post",   path: `${BASE}/import/yaml` },
    { method: "get",    path: `${BASE}/some-id/revisions` },
    { method: "get",    path: `${BASE}/some-id/revisions/1` },
    { method: "post",   path: `${BASE}/some-id/rollback/1` },
  ];

  test.each(endpoints)("$method $path → 401 with no token", async ({ method, path }) => {
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(401);
  });

  test.each(endpoints)("$method $path → 403 with wrong token", async ({ method, path }) => {
    const res = await (request(app) as any)[method](path)
      .set("x-chronopay-admin-token", "bad-token")
      .send({});
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIST CALENDARS
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /holiday-calendars", () => {
  it("returns empty array when no calendars exist", async () => {
    const res = await request(app).get(BASE).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, calendars: [] });
  });

  it("returns all created calendars", async () => {
    await repo.createCalendar({ region: "us-east", name: "US East" });
    await repo.createCalendar({ region: "eu-west", name: "EU West" });

    const res = await request(app).get(BASE).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.calendars).toHaveLength(2);
    const regions = res.body.calendars.map((c: any) => c.region);
    expect(regions).toContain("us-east");
    expect(regions).toContain("eu-west");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /holiday-calendars", () => {
  it("creates a calendar and returns 201", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR).send(VALID_CALENDAR);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.calendar).toMatchObject({
      region: "us-east",
      name: "US East Holidays",
      entries: [],
    });
    expect(res.body.calendar.id).toBeDefined();
  });

  it("normalises region to lowercase", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR)
      .send({ region: "US-EAST", name: "Test" });
    expect(res.status).toBe(201);
    expect(res.body.calendar.region).toBe("us-east");
  });

  it("returns 400 when region is missing", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR).send({ name: "No Region" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/region/i);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR).send({ region: "us-east" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when region is empty string", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR)
      .send({ region: "  ", name: "Test" });
    expect(res.status).toBe(400);
  });

  it("returns 409 when a calendar for the same region already exists", async () => {
    await request(app).post(BASE).set(ADMIN_HDR).send(VALID_CALENDAR);
    const res = await request(app).post(BASE).set(ADMIN_HDR).send(VALID_CALENDAR);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("stores an optional description", async () => {
    const res = await request(app).post(BASE).set(ADMIN_HDR)
      .send({ ...VALID_CALENDAR, description: "Primary US-East calendar" });
    expect(res.status).toBe(201);
    expect(res.body.calendar.description).toBe("Primary US-East calendar");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET CALENDAR BY ID
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /holiday-calendars/:id", () => {
  it("returns the calendar with its entries", async () => {
    const created = await repo.createCalendar({ region: "apac", name: "APAC" });
    await repo.addEntry(created.id, {
      name: "Lunar New Year", startDate: "2025-01-29", endDate: "2025-01-29", recurring: true,
    });

    const res = await request(app).get(`${BASE}/${created.id}`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.calendar.region).toBe("apac");
    expect(res.body.calendar.entries).toHaveLength(1);
    expect(res.body.calendar.entries[0].name).toBe("Lunar New Year");
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app).get(`${BASE}/nonexistent-id`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /holiday-calendars/:id", () => {
  let calendarId: string;

  beforeEach(async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "Old Name" });
    calendarId = cal.id;
  });

  it("updates name and returns the patched calendar", async () => {
    const res = await request(app).patch(`${BASE}/${calendarId}`).set(ADMIN_HDR)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.calendar.name).toBe("New Name");
  });

  it("updates description", async () => {
    const res = await request(app).patch(`${BASE}/${calendarId}`).set(ADMIN_HDR)
      .send({ description: "Updated desc" });
    expect(res.status).toBe(200);
    expect(res.body.calendar.description).toBe("Updated desc");
  });

  it("returns 400 when name is empty string", async () => {
    const res = await request(app).patch(`${BASE}/${calendarId}`).set(ADMIN_HDR)
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app).patch(`${BASE}/no-such-id`).set(ADMIN_HDR)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("saves a new revision on update", async () => {
    await request(app).patch(`${BASE}/${calendarId}`).set(ADMIN_HDR).send({ name: "Rev 2" });
    const revRes = await request(app).get(`${BASE}/${calendarId}/revisions`).set(ADMIN_HDR);
    expect(revRes.body.revisions.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /holiday-calendars/:id", () => {
  it("deletes an existing calendar and returns 200", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    const res = await request(app).delete(`${BASE}/${cal.id}`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 404 when calendar does not exist", async () => {
    const res = await request(app).delete(`${BASE}/ghost-id`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("subsequent GET returns 404 after deletion", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    await request(app).delete(`${BASE}/${cal.id}`).set(ADMIN_HDR);
    const res = await request(app).get(`${BASE}/${cal.id}`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADD ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /holiday-calendars/:id/entries", () => {
  let calendarId: string;

  beforeEach(async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    calendarId = cal.id;
  });

  it("adds an entry and returns 201", async () => {
    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send(VALID_ENTRY);
    expect(res.status).toBe(201);
    expect(res.body.entry.name).toBe("New Year");
    expect(res.body.entry.startDate).toBe("2025-01-01");
    expect(res.body.entry.endDate).toBe("2025-01-01");
    expect(res.body.entry.recurring).toBe(true);
  });

  it("supports multi-day range entries", async () => {
    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ name: "Spring Break", start_date: "2025-03-15", end_date: "2025-03-22" });
    expect(res.status).toBe(201);
    expect(res.body.entry.startDate).toBe("2025-03-15");
    expect(res.body.entry.endDate).toBe("2025-03-22");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ start_date: "2025-01-01", end_date: "2025-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when start_date is missing", async () => {
    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ name: "Holiday", end_date: "2025-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start_date/i);
  });

  it("returns 400 when end_date is missing", async () => {
    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ name: "Holiday", start_date: "2025-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/end_date/i);
  });

  it("returns 404 when calendar does not exist", async () => {
    const res = await request(app).post(`${BASE}/no-cal/entries`)
      .set(ADMIN_HDR).send(VALID_ENTRY);
    expect(res.status).toBe(404);
  });

  it("returns 422 when new entry overlaps an existing one", async () => {
    await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ name: "Xmas Week", start_date: "2025-12-24", end_date: "2025-12-28" });

    const res = await request(app).post(`${BASE}/${calendarId}/entries`)
      .set(ADMIN_HDR).send({ name: "Boxing Day", start_date: "2025-12-26", end_date: "2025-12-26" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/overlap/i);
  });

  it("saves a revision after adding an entry", async () => {
    await request(app).post(`${BASE}/${calendarId}/entries`).set(ADMIN_HDR).send(VALID_ENTRY);
    const revRes = await request(app).get(`${BASE}/${calendarId}/revisions`).set(ADMIN_HDR);
    expect(revRes.body.revisions.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE ENTRY
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /holiday-calendars/:id/entries/:entryId", () => {
  let calendarId: string;
  let entryId: string;

  beforeEach(async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    calendarId = cal.id;
    const entry = await repo.addEntry(calendarId, {
      name: "Labor Day", startDate: "2025-09-01", endDate: "2025-09-01", recurring: true,
    });
    entryId = entry.id;
  });

  it("deletes an entry and returns 200", async () => {
    const res = await request(app)
      .delete(`${BASE}/${calendarId}/entries/${entryId}`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("entry is gone after deletion", async () => {
    await request(app).delete(`${BASE}/${calendarId}/entries/${entryId}`).set(ADMIN_HDR);
    const cal = await request(app).get(`${BASE}/${calendarId}`).set(ADMIN_HDR);
    expect(cal.body.calendar.entries).toHaveLength(0);
  });

  it("returns 404 when calendar does not exist", async () => {
    const res = await request(app)
      .delete(`${BASE}/bad-cal/entries/${entryId}`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("returns 404 when entry does not exist in the calendar", async () => {
    const res = await request(app)
      .delete(`${BASE}/${calendarId}/entries/no-such-entry`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("saves a revision after deleting an entry", async () => {
    await request(app).delete(`${BASE}/${calendarId}/entries/${entryId}`).set(ADMIN_HDR);
    const revRes = await request(app).get(`${BASE}/${calendarId}/revisions`).set(ADMIN_HDR);
    expect(revRes.body.revisions.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// YAML IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /holiday-calendars/import/yaml", () => {
  const IMPORT_URL = `${BASE}/import/yaml`;

  it("imports a valid payload and returns 200 with the calendar", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(VALID_YAML_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.calendar.region).toBe("eu-west");
    expect(res.body.calendar.entries).toHaveLength(2);
  });

  it("creates the calendar if region does not exist yet", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR)
      .send({ region: "brand-new", name: "Brand New Region", holidays: [
        { name: "Founder Day", start_date: "2025-06-01", end_date: "2025-06-01" },
      ]});
    expect(res.status).toBe(200);
    expect(res.body.calendar.region).toBe("brand-new");
  });

  it("replaces existing entries on re-import for same region", async () => {
    await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(VALID_YAML_PAYLOAD);

    const updated = {
      region: "eu-west",
      holidays: [
        { name: "Only Holiday", start_date: "2025-07-14", end_date: "2025-07-14" },
      ],
    };
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(updated);
    expect(res.status).toBe(200);
    expect(res.body.calendar.entries).toHaveLength(1);
    expect(res.body.calendar.entries[0].name).toBe("Only Holiday");
  });

  it("normalises region to lowercase on import", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      region: "APAC-SOUTH",
      holidays: [{ name: "Day Off", start_date: "2025-08-01", end_date: "2025-08-01" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.calendar.region).toBe("apac-south");
  });

  it("returns 422 when region is missing", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      holidays: [{ name: "Day", start_date: "2025-01-01", end_date: "2025-01-01" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/schema validation/i);
  });

  it("returns 422 when holidays array is empty", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR)
      .send({ region: "eu-west", holidays: [] });
    expect(res.status).toBe(422);
  });

  it("returns 422 when a holiday has no name", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      region: "eu-west",
      holidays: [{ start_date: "2025-01-01", end_date: "2025-01-01" }],
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when start_date has wrong format", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      region: "eu-west",
      holidays: [{ name: "Bad Date", start_date: "01/01/2025", end_date: "2025-01-01" }],
    });
    expect(res.status).toBe(422);
    expect(res.body.details).toBeDefined();
  });

  it("returns 422 when end_date has wrong format", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      region: "eu-west",
      holidays: [{ name: "Bad Date", start_date: "2025-01-01", end_date: "not-a-date" }],
    });
    expect(res.status).toBe(422);
  });

  it("returns 422 when two holidays in the import overlap", async () => {
    const res = await request(app).post(IMPORT_URL).set(ADMIN_HDR).send({
      region: "eu-west",
      holidays: [
        { name: "Week A", start_date: "2025-03-10", end_date: "2025-03-14" },
        { name: "Week B", start_date: "2025-03-12", end_date: "2025-03-16" },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/overlap/i);
  });

  it("saves a revision after import", async () => {
    await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(VALID_YAML_PAYLOAD);
    const calendars = await request(app).get(BASE).set(ADMIN_HDR);
    const cal = calendars.body.calendars.find((c: any) => c.region === "eu-west");
    const revRes = await request(app).get(`${BASE}/${cal.id}/revisions`).set(ADMIN_HDR);
    expect(revRes.body.revisions).toHaveLength(1);
  });

  it("increments revision on subsequent imports of same region", async () => {
    await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(VALID_YAML_PAYLOAD);
    await request(app).post(IMPORT_URL).set(ADMIN_HDR).send(VALID_YAML_PAYLOAD);
    const calendars = await request(app).get(BASE).set(ADMIN_HDR);
    const cal = calendars.body.calendars.find((c: any) => c.region === "eu-west");
    const revRes = await request(app).get(`${BASE}/${cal.id}/revisions`).set(ADMIN_HDR);
    expect(revRes.body.revisions).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REVISIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /holiday-calendars/:id/revisions", () => {
  it("returns empty array before any mutations", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    const res = await request(app).get(`${BASE}/${cal.id}/revisions`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.revisions).toEqual([]);
  });

  it("returns 404 for unknown calendar", async () => {
    const res = await request(app).get(`${BASE}/no-cal/revisions`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("lists revisions newest-first after multiple changes", async () => {
    const svc = new HolidayCalendarService(repo);
    const cal = await svc.createCalendar({ region: "us-east", name: "Rev Test" });
    await svc.updateCalendar(cal.id, { name: "Rev Test v2" });
    await svc.updateCalendar(cal.id, { name: "Rev Test v3" });

    const res = await request(app).get(`${BASE}/${cal.id}/revisions`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    const versions = res.body.revisions.map((r: any) => r.version);
    expect(versions[0]).toBeGreaterThan(versions[1]);
  });
});

describe("GET /holiday-calendars/:id/revisions/:version", () => {
  it("returns the correct snapshot for version 1", async () => {
    const svc = new HolidayCalendarService(repo);
    const cal = await svc.createCalendar({ region: "us-east", name: "Original Name" });
    await svc.updateCalendar(cal.id, { name: "Updated Name" });

    const res = await request(app).get(`${BASE}/${cal.id}/revisions/1`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.revision.version).toBe(1);
    expect(res.body.revision.snapshot.name).toBe("Original Name");
  });

  it("returns 404 for a version that does not exist", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    const res = await request(app).get(`${BASE}/${cal.id}/revisions/99`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-integer version parameter", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    const res = await request(app).get(`${BASE}/${cal.id}/revisions/abc`).set(ADMIN_HDR);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });

  it("returns 400 for version 0", async () => {
    const cal = await repo.createCalendar({ region: "us-east", name: "US East" });
    const res = await request(app).get(`${BASE}/${cal.id}/revisions/0`).set(ADMIN_HDR);
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown calendar", async () => {
    const res = await request(app).get(`${BASE}/ghost/revisions/1`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /holiday-calendars/:id/rollback/:version", () => {
  let calendarId: string;

  beforeEach(async () => {
    const svc = new HolidayCalendarService(repo);
    // v1 — "Original Name", no entries
    const cal = await svc.createCalendar({ region: "us-east", name: "Original Name" });
    calendarId = cal.id;
    // v2 — name changed, one entry added
    await svc.updateCalendar(calendarId, { name: "Updated Name" });
    await svc.addEntry(calendarId, {
      name: "Thanksgiving", startDate: "2025-11-27", endDate: "2025-11-27", recurring: true,
    });
  });

  it("rolls back to version 1, restoring original name and empty entries", async () => {
    const res = await request(app)
      .post(`${BASE}/${calendarId}/rollback/1`).set(ADMIN_HDR);
    expect(res.status).toBe(200);
    expect(res.body.calendar.name).toBe("Original Name");
    expect(res.body.calendar.entries).toHaveLength(0);
  });

  it("saves a new revision recording the rollback", async () => {
    const revsBefore = (await request(app).get(`${BASE}/${calendarId}/revisions`).set(ADMIN_HDR))
      .body.revisions.length;
    await request(app).post(`${BASE}/${calendarId}/rollback/1`).set(ADMIN_HDR);
    const revsAfter = (await request(app).get(`${BASE}/${calendarId}/revisions`).set(ADMIN_HDR))
      .body.revisions.length;
    expect(revsAfter).toBe(revsBefore + 1);
  });

  it("returns 404 when the version does not exist", async () => {
    const res = await request(app)
      .post(`${BASE}/${calendarId}/rollback/99`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown calendar", async () => {
    const res = await request(app).post(`${BASE}/ghost-id/rollback/1`).set(ADMIN_HDR);
    expect(res.status).toBe(404);
  });

  it("returns 400 for non-integer version", async () => {
    const res = await request(app)
      .post(`${BASE}/${calendarId}/rollback/bad`).set(ADMIN_HDR);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT — detectEntryOverlaps helper
// ═══════════════════════════════════════════════════════════════════════════════

describe("detectEntryOverlaps()", () => {
  it("returns empty array for a single entry", () => {
    expect(detectEntryOverlaps([
      { name: "A", startDate: "2025-01-01", endDate: "2025-01-01" },
    ])).toHaveLength(0);
  });

  it("returns empty array for non-overlapping entries", () => {
    expect(detectEntryOverlaps([
      { name: "A", startDate: "2025-01-01", endDate: "2025-01-03" },
      { name: "B", startDate: "2025-01-04", endDate: "2025-01-06" },
      { name: "C", startDate: "2025-03-01", endDate: "2025-03-31" },
    ])).toHaveLength(0);
  });

  it("flags adjacent entries that share a boundary day", () => {
    const errors = detectEntryOverlaps([
      { name: "A", startDate: "2025-01-01", endDate: "2025-01-03" },
      { name: "B", startDate: "2025-01-03", endDate: "2025-01-05" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"A".*"B"|"B".*"A"/);
  });

  it("flags a full overlap (one range inside another)", () => {
    const errors = detectEntryOverlaps([
      { name: "Outer", startDate: "2025-03-01", endDate: "2025-03-31" },
      { name: "Inner", startDate: "2025-03-10", endDate: "2025-03-15" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports an error when end_date < start_date", () => {
    const errors = detectEntryOverlaps([
      { name: "Bad", startDate: "2025-06-10", endDate: "2025-06-05" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/end_date.*>=.*start_date/i);
  });

  it("flags multiple independent overlap pairs", () => {
    const errors = detectEntryOverlaps([
      { name: "A", startDate: "2025-01-01", endDate: "2025-01-05" },
      { name: "B", startDate: "2025-01-03", endDate: "2025-01-07" }, // overlaps A
      { name: "C", startDate: "2025-02-10", endDate: "2025-02-15" },
      { name: "D", startDate: "2025-02-12", endDate: "2025-02-18" }, // overlaps C
    ]);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT — Named error classes
// ═══════════════════════════════════════════════════════════════════════════════

describe("Named error classes", () => {
  it("HolidayCalendarNotFoundError has status 404", () => {
    const err = new HolidayCalendarNotFoundError("abc");
    expect(err.status).toBe(404);
    expect(err.message).toContain("abc");
    expect(err.name).toBe("HolidayCalendarNotFoundError");
  });

  it("HolidayCalendarConflictError has status 409", () => {
    const err = new HolidayCalendarConflictError("region conflict");
    expect(err.status).toBe(409);
    expect(err.name).toBe("HolidayCalendarConflictError");
  });

  it("HolidayCalendarValidationError has status 422 and carries details", () => {
    const details = [{ path: "holidays", message: "overlap" }];
    const err = new HolidayCalendarValidationError("bad input", details);
    expect(err.status).toBe(422);
    expect(err.details).toEqual(details);
    expect(err.name).toBe("HolidayCalendarValidationError");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT — HolidayCalendarService (pure, no HTTP layer)
// ═══════════════════════════════════════════════════════════════════════════════

describe("HolidayCalendarService — unit", () => {
  let svc: HolidayCalendarService;
  let unitRepo: InMemoryHolidayCalendarRepository;

  beforeEach(() => {
    unitRepo = new InMemoryHolidayCalendarRepository();
    svc = new HolidayCalendarService(unitRepo);
  });

  // ── createCalendar ──────────────────────────────────────────────────────────

  describe("createCalendar()", () => {
    it("creates a calendar and records revision v1", async () => {
      const cal = await svc.createCalendar({ region: "ap-south", name: "AP South" });
      expect(cal.region).toBe("ap-south");
      const revisions = await svc.listRevisions(cal.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0].version).toBe(1);
      expect(revisions[0].changeNote).toBe("Initial creation");
    });

    it("trims whitespace from region and name", async () => {
      const cal = await svc.createCalendar({ region: "  us-west  ", name: "  US West  " });
      expect(cal.region).toBe("us-west");
      expect(cal.name).toBe("US West");
    });

    it("throws HolidayCalendarConflictError for duplicate region", async () => {
      await svc.createCalendar({ region: "eu-north", name: "EU North" });
      await expect(svc.createCalendar({ region: "eu-north", name: "Another" }))
        .rejects.toBeInstanceOf(HolidayCalendarConflictError);
    });
  });

  // ── updateCalendar ──────────────────────────────────────────────────────────

  describe("updateCalendar()", () => {
    it("updates name and records a new revision", async () => {
      const cal = await svc.createCalendar({ region: "sa-east", name: "SA East" });
      const updated = await svc.updateCalendar(cal.id, { name: "SA East 2" });
      expect(updated.name).toBe("SA East 2");
      const revisions = await svc.listRevisions(cal.id);
      expect(revisions.length).toBeGreaterThanOrEqual(2);
    });

    it("throws HolidayCalendarNotFoundError for unknown id", async () => {
      await expect(svc.updateCalendar("ghost", { name: "X" }))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });
  });

  // ── deleteCalendar ──────────────────────────────────────────────────────────

  describe("deleteCalendar()", () => {
    it("deletes the calendar; subsequent getCalendar throws", async () => {
      const cal = await svc.createCalendar({ region: "me-central", name: "ME" });
      await svc.deleteCalendar(cal.id);
      await expect(svc.getCalendar(cal.id))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });

    it("throws HolidayCalendarNotFoundError for unknown id", async () => {
      await expect(svc.deleteCalendar("ghost"))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });
  });

  // ── addEntry ────────────────────────────────────────────────────────────────

  describe("addEntry()", () => {
    it("adds entry and it appears in getCalendar", async () => {
      const cal = await svc.createCalendar({ region: "ca-central", name: "Canada" });
      await svc.addEntry(cal.id, {
        name: "Victoria Day", startDate: "2025-05-19", endDate: "2025-05-19",
      });
      const fetched = await svc.getCalendar(cal.id);
      expect(fetched.entries).toHaveLength(1);
    });

    it("throws HolidayCalendarNotFoundError for unknown calendar", async () => {
      await expect(
        svc.addEntry("ghost", { name: "X", startDate: "2025-01-01", endDate: "2025-01-01" })
      ).rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });

    it("throws HolidayCalendarValidationError when new entry overlaps existing", async () => {
      const cal = await svc.createCalendar({ region: "au-east", name: "AU East" });
      await svc.addEntry(cal.id, { name: "Xmas", startDate: "2025-12-24", endDate: "2025-12-26" });
      await expect(
        svc.addEntry(cal.id, { name: "Boxing Day", startDate: "2025-12-25", endDate: "2025-12-27" })
      ).rejects.toBeInstanceOf(HolidayCalendarValidationError);
    });
  });

  // ── deleteEntry ─────────────────────────────────────────────────────────────

  describe("deleteEntry()", () => {
    it("removes the entry from the calendar", async () => {
      const cal = await svc.createCalendar({ region: "nz", name: "NZ" });
      const entry = await unitRepo.addEntry(cal.id, {
        name: "Waitangi Day", startDate: "2025-02-06", endDate: "2025-02-06", recurring: true,
      });
      await svc.deleteEntry(cal.id, entry.id);
      const fetched = await svc.getCalendar(cal.id);
      expect(fetched.entries).toHaveLength(0);
    });

    it("throws HolidayCalendarNotFoundError for unknown entry", async () => {
      const cal = await svc.createCalendar({ region: "nz", name: "NZ" });
      await expect(svc.deleteEntry(cal.id, "no-such-entry"))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });
  });

  // ── importFromYaml ──────────────────────────────────────────────────────────

  describe("importFromYaml()", () => {
    it("creates a new calendar on first import", async () => {
      const cal = await svc.importFromYaml({
        region: "jp",
        name: "Japan",
        holidays: [{ name: "Showa Day", start_date: "2025-04-29", end_date: "2025-04-29" }],
      });
      expect(cal.region).toBe("jp");
      expect(cal.entries).toHaveLength(1);
    });

    it("replaces entries on subsequent import of same region", async () => {
      await svc.importFromYaml({
        region: "jp",
        holidays: [
          { name: "Old Holiday", start_date: "2025-05-01", end_date: "2025-05-01" },
          { name: "Another Old", start_date: "2025-06-01", end_date: "2025-06-01" },
        ],
      });
      const cal = await svc.importFromYaml({
        region: "jp",
        holidays: [{ name: "New Holiday", start_date: "2025-07-04", end_date: "2025-07-04" }],
      });
      expect(cal.entries).toHaveLength(1);
      expect(cal.entries[0].name).toBe("New Holiday");
    });

    it("throws HolidayCalendarValidationError for invalid schema", async () => {
      await expect(svc.importFromYaml({ region: "", holidays: [] }))
        .rejects.toBeInstanceOf(HolidayCalendarValidationError);
    });

    it("throws HolidayCalendarValidationError for overlapping holidays", async () => {
      await expect(svc.importFromYaml({
        region: "jp",
        holidays: [
          { name: "Week A", start_date: "2025-08-01", end_date: "2025-08-07" },
          { name: "Week B", start_date: "2025-08-05", end_date: "2025-08-10" },
        ],
      })).rejects.toBeInstanceOf(HolidayCalendarValidationError);
    });

    it("saves revision v1 for new region, increments for existing", async () => {
      await svc.importFromYaml({
        region: "sg",
        holidays: [{ name: "National Day", start_date: "2025-08-09", end_date: "2025-08-09" }],
      });
      const cal = await unitRepo.findCalendarByRegion("sg");
      const revs1 = await svc.listRevisions(cal!.id);
      expect(revs1[0].version).toBe(1);

      await svc.importFromYaml({
        region: "sg",
        holidays: [{ name: "National Day", start_date: "2025-08-09", end_date: "2025-08-09" }],
      });
      const revs2 = await svc.listRevisions(cal!.id);
      expect(revs2[0].version).toBe(2);
    });
  });

  // ── rollbackToRevision ──────────────────────────────────────────────────────

  describe("rollbackToRevision()", () => {
    it("restores name and entries from the specified version", async () => {
      const cal = await svc.createCalendar({ region: "kr", name: "Korea v1" });
      await svc.addEntry(cal.id, {
        name: "Chuseok", startDate: "2025-10-06", endDate: "2025-10-08", recurring: true,
      });
      await svc.updateCalendar(cal.id, { name: "Korea v2" });

      // Roll back to version 1 (name = "Korea v1", no entries)
      const restored = await svc.rollbackToRevision(cal.id, 1);
      expect(restored.name).toBe("Korea v1");
      expect(restored.entries).toHaveLength(0);
    });

    it("records the rollback as a new revision", async () => {
      const cal = await svc.createCalendar({ region: "th", name: "Thailand" });
      await svc.updateCalendar(cal.id, { name: "Thailand v2" });
      const countBefore = (await svc.listRevisions(cal.id)).length;
      await svc.rollbackToRevision(cal.id, 1);
      const countAfter = (await svc.listRevisions(cal.id)).length;
      expect(countAfter).toBe(countBefore + 1);
    });

    it("throws HolidayCalendarNotFoundError for unknown version", async () => {
      const cal = await svc.createCalendar({ region: "vn", name: "Vietnam" });
      await expect(svc.rollbackToRevision(cal.id, 99))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });

    it("throws HolidayCalendarNotFoundError for unknown calendar", async () => {
      await expect(svc.rollbackToRevision("ghost-id", 1))
        .rejects.toBeInstanceOf(HolidayCalendarNotFoundError);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT — InMemoryHolidayCalendarRepository
// ═══════════════════════════════════════════════════════════════════════════════

describe("InMemoryHolidayCalendarRepository", () => {
  let r: InMemoryHolidayCalendarRepository;

  beforeEach(() => { r = new InMemoryHolidayCalendarRepository(); });

  it("findCalendarById returns null for unknown id", async () => {
    expect(await r.findCalendarById("x")).toBeNull();
  });

  it("findCalendarByRegion returns null when no match", async () => {
    expect(await r.findCalendarByRegion("nowhere")).toBeNull();
  });

  it("listCalendars returns all created calendars", async () => {
    await r.createCalendar({ region: "a", name: "A" });
    await r.createCalendar({ region: "b", name: "B" });
    expect(await r.listCalendars()).toHaveLength(2);
  });

  it("deleteCalendar removes the calendar from list", async () => {
    const cal = await r.createCalendar({ region: "del-me", name: "Delete" });
    await r.deleteCalendar(cal.id);
    expect(await r.findCalendarById(cal.id)).toBeNull();
    expect(await r.listCalendars()).toHaveLength(0);
  });

  it("replaceEntries replaces all previous entries", async () => {
    const cal = await r.createCalendar({ region: "rp", name: "Replace" });
    await r.addEntry(cal.id, { name: "Old", startDate: "2025-01-01", endDate: "2025-01-01", recurring: false });
    await r.replaceEntries(cal.id, [
      { name: "New A", startDate: "2025-02-01", endDate: "2025-02-01", recurring: false },
      { name: "New B", startDate: "2025-03-01", endDate: "2025-03-01", recurring: false },
    ]);
    const fetched = await r.findCalendarById(cal.id);
    expect(fetched!.entries).toHaveLength(2);
    expect(fetched!.entries.map((e) => e.name)).not.toContain("Old");
  });

  it("getRevision returns null for unknown version", async () => {
    const cal = await r.createCalendar({ region: "rev-null", name: "X" });
    expect(await r.getRevision(cal.id, 999)).toBeNull();
  });

  it("saveRevision + listRevisions returns newest-first", async () => {
    const cal = await r.createCalendar({ region: "rev-order", name: "X" });
    const snapshot = { ...cal, entries: [] };
    await r.saveRevision({ calendarId: cal.id, version: 1, snapshot, changedBy: "test", changeNote: "v1" });
    await r.saveRevision({ calendarId: cal.id, version: 2, snapshot, changedBy: "test", changeNote: "v2" });
    const revs = await r.listRevisions(cal.id);
    expect(revs[0].version).toBe(2);
    expect(revs[1].version).toBe(1);
  });

  it("reset() clears all state", async () => {
    await r.createCalendar({ region: "x", name: "X" });
    r.reset();
    expect(await r.listCalendars()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASES — end-to-end multi-step flows
// ═══════════════════════════════════════════════════════════════════════════════

describe("End-to-end multi-step flows", () => {
  it("full lifecycle: create → add entries → update → rollback → verify", async () => {
    // 1. Create
    const create = await request(app).post(BASE).set(ADMIN_HDR)
      .send({ region: "lifecycle-test", name: "Lifecycle v1" });
    expect(create.status).toBe(201);
    const id = create.body.calendar.id;

    // 2. Add two non-overlapping entries
    await request(app).post(`${BASE}/${id}/entries`).set(ADMIN_HDR)
      .send({ name: "Holiday A", start_date: "2025-02-01", end_date: "2025-02-01" });
    await request(app).post(`${BASE}/${id}/entries`).set(ADMIN_HDR)
      .send({ name: "Holiday B", start_date: "2025-03-01", end_date: "2025-03-01" });

    // 3. Verify 2 entries
    const getRes = await request(app).get(`${BASE}/${id}`).set(ADMIN_HDR);
    expect(getRes.body.calendar.entries).toHaveLength(2);

    // 4. Update name → new revision
    await request(app).patch(`${BASE}/${id}`).set(ADMIN_HDR).send({ name: "Lifecycle v2" });

    // 5. Get revision 1 snapshot — should have original name and 0 entries
    const rev1 = await request(app).get(`${BASE}/${id}/revisions/1`).set(ADMIN_HDR);
    expect(rev1.status).toBe(200);
    expect(rev1.body.revision.snapshot.name).toBe("Lifecycle v1");
    expect(rev1.body.revision.snapshot.entries).toHaveLength(0);

    // 6. Rollback to v1
    const rollback = await request(app).post(`${BASE}/${id}/rollback/1`).set(ADMIN_HDR);
    expect(rollback.status).toBe(200);
    expect(rollback.body.calendar.name).toBe("Lifecycle v1");
    expect(rollback.body.calendar.entries).toHaveLength(0);

    // 7. Verify revisions list grows
    const revList = await request(app).get(`${BASE}/${id}/revisions`).set(ADMIN_HDR);
    expect(revList.body.revisions.length).toBeGreaterThanOrEqual(4);
  });

  it("YAML import followed by single-entry add works without overlaps", async () => {
    const importRes = await request(app).post(`${BASE}/import/yaml`).set(ADMIN_HDR).send({
      region: "flow-test",
      name: "Flow Test",
      holidays: [
        { name: "Day 1", start_date: "2025-01-15", end_date: "2025-01-15" },
        { name: "Day 2", start_date: "2025-02-15", end_date: "2025-02-15" },
      ],
    });
    expect(importRes.status).toBe(200);
    const id = importRes.body.calendar.id;

    const addRes = await request(app).post(`${BASE}/${id}/entries`).set(ADMIN_HDR)
      .send({ name: "Day 3", start_date: "2025-03-15", end_date: "2025-03-15" });
    expect(addRes.status).toBe(201);

    const cal = await request(app).get(`${BASE}/${id}`).set(ADMIN_HDR);
    expect(cal.body.calendar.entries).toHaveLength(3);
  });

  it("YAML import then overlap-entry add is rejected", async () => {
    const importRes = await request(app).post(`${BASE}/import/yaml`).set(ADMIN_HDR).send({
      region: "overlap-flow",
      holidays: [{ name: "Week", start_date: "2025-04-01", end_date: "2025-04-07" }],
    });
    const id = importRes.body.calendar.id;

    const addRes = await request(app).post(`${BASE}/${id}/entries`).set(ADMIN_HDR)
      .send({ name: "Mid-week", start_date: "2025-04-03", end_date: "2025-04-03" });
    expect(addRes.status).toBe(422);
  });

  it("deleting a calendar removes it from the list", async () => {
    const c1 = await request(app).post(BASE).set(ADMIN_HDR)
      .send({ region: "delete-flow-1", name: "D1" });
    await request(app).post(BASE).set(ADMIN_HDR)
      .send({ region: "delete-flow-2", name: "D2" });
    await request(app).delete(`${BASE}/${c1.body.calendar.id}`).set(ADMIN_HDR);

    const list = await request(app).get(BASE).set(ADMIN_HDR);
    const regions = list.body.calendars.map((c: any) => c.region);
    expect(regions).not.toContain("delete-flow-1");
    expect(regions).toContain("delete-flow-2");
  });
});

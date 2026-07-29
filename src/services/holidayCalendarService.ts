/**
 * HolidayCalendarService
 *
 * Manages holiday calendars with:
 *  - Full CRUD (create, read, update, delete)
 *  - Per-region YAML import with schema validation and overlap detection
 *  - Append-only revision history for rollback
 *
 * The service is designed for dependency injection — the repository
 * interface is passed in at construction time so tests can swap in an
 * in-memory implementation without touching the database.
 */

import { z } from "zod";

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface HolidayEntry {
  id: string;
  calendarId: string;
  name: string;
  /** Inclusive start date (YYYY-MM-DD) */
  startDate: string;
  /** Inclusive end date (YYYY-MM-DD) — equals startDate for single-day holidays */
  endDate: string;
  recurring: boolean;
  note?: string;
  createdAt: string;
}

export interface HolidayCalendar {
  id: string;
  region: string;
  name: string;
  description?: string;
  entries: HolidayEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface HolidayCalendarRevision {
  id: string;
  calendarId: string;
  version: number;
  snapshot: HolidayCalendar;
  changedBy?: string;
  changeNote?: string;
  createdAt: string;
}

// ─── Repository interface (database abstraction) ──────────────────────────────

export interface IHolidayCalendarRepository {
  createCalendar(input: {
    region: string;
    name: string;
    description?: string;
  }): Promise<HolidayCalendar>;

  findCalendarById(id: string): Promise<HolidayCalendar | null>;
  findCalendarByRegion(region: string): Promise<HolidayCalendar | null>;
  listCalendars(): Promise<HolidayCalendar[]>;

  updateCalendar(
    id: string,
    patch: { name?: string; description?: string },
  ): Promise<HolidayCalendar>;

  deleteCalendar(id: string): Promise<void>;

  addEntry(
    calendarId: string,
    entry: Omit<HolidayEntry, "id" | "calendarId" | "createdAt">,
  ): Promise<HolidayEntry>;

  replaceEntries(
    calendarId: string,
    entries: Omit<HolidayEntry, "id" | "calendarId" | "createdAt">[],
  ): Promise<HolidayEntry[]>;

  deleteEntry(calendarId: string, entryId: string): Promise<void>;

  saveRevision(revision: Omit<HolidayCalendarRevision, "id" | "createdAt">): Promise<HolidayCalendarRevision>;
  listRevisions(calendarId: string): Promise<HolidayCalendarRevision[]>;
  getRevision(calendarId: string, version: number): Promise<HolidayCalendarRevision | null>;
}

// ─── Zod validation schemas ───────────────────────────────────────────────────

/** ISO-8601 date string: YYYY-MM-DD */
const ISODate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
  .refine((s) => !isNaN(Date.parse(s)), { message: "Must be a valid calendar date" });

export const HolidayEntryImportSchema = z.object({
  name: z.string().min(1, "Holiday name is required"),
  start_date: ISODate,
  end_date: ISODate,
  recurring: z.boolean().optional().default(false),
  note: z.string().optional(),
});

export const YamlImportSchema = z.object({
  region: z.string().min(1, "region is required"),
  name: z.string().min(1, "Calendar name is required").optional(),
  description: z.string().optional(),
  holidays: z.array(HolidayEntryImportSchema).min(1, "At least one holiday is required"),
});

export type YamlImportPayload = z.infer<typeof YamlImportSchema>;

// ─── Named errors ─────────────────────────────────────────────────────────────

export class HolidayCalendarNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`Holiday calendar not found: ${id}`);
    this.name = "HolidayCalendarNotFoundError";
  }
}

export class HolidayCalendarConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "HolidayCalendarConflictError";
  }
}

export class HolidayCalendarValidationError extends Error {
  readonly status = 422;
  readonly details: { path: string; message: string }[];
  constructor(message: string, details: { path: string; message: string }[] = []) {
    super(message);
    this.name = "HolidayCalendarValidationError";
    this.details = details;
  }
}

// ─── Overlap detection ────────────────────────────────────────────────────────

/**
 * Returns true if [aStart, aEnd] and [bStart, bEnd] overlap (inclusive on both ends).
 * Dates are compared as ISO strings (lexicographic ordering works for YYYY-MM-DD).
 */
function datesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Validates a list of holiday entries for:
 *  1. end_date >= start_date per entry
 *  2. No two entries within the same calendar overlap each other
 *
 * Returns an array of validation error messages; empty means valid.
 */
export function detectEntryOverlaps(
  entries: Pick<HolidayEntry, "name" | "startDate" | "endDate">[],
): string[] {
  const errors: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.endDate < e.startDate) {
      errors.push(`Entry "${e.name}": end_date (${e.endDate}) must be >= start_date (${e.startDate})`);
    }
  }

  // Pairwise overlap check — O(n²) but holiday lists are small
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (datesOverlap(a.startDate, a.endDate, b.startDate, b.endDate)) {
        errors.push(
          `Entries "${a.name}" (${a.startDate}–${a.endDate}) and "${b.name}" (${b.startDate}–${b.endDate}) have overlapping date ranges`,
        );
      }
    }
  }

  return errors;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class HolidayCalendarService {
  constructor(private readonly repo: IHolidayCalendarRepository) {}

  // ── Calendars ──────────────────────────────────────────────────────────────

  async listCalendars(): Promise<HolidayCalendar[]> {
    return this.repo.listCalendars();
  }

  async getCalendar(id: string): Promise<HolidayCalendar> {
    const calendar = await this.repo.findCalendarById(id);
    if (!calendar) throw new HolidayCalendarNotFoundError(id);
    return calendar;
  }

  async createCalendar(input: {
    region: string;
    name: string;
    description?: string;
    changedBy?: string;
  }): Promise<HolidayCalendar> {
    const region = input.region.trim().toLowerCase();

    const existing = await this.repo.findCalendarByRegion(region);
    if (existing) {
      throw new HolidayCalendarConflictError(
        `A holiday calendar already exists for region "${region}"`,
      );
    }

    const calendar = await this.repo.createCalendar({
      region,
      name: input.name.trim(),
      description: input.description?.trim(),
    });

    await this._saveRevision(calendar, 1, input.changedBy, "Initial creation");
    return calendar;
  }

  async updateCalendar(
    id: string,
    patch: { name?: string; description?: string; changedBy?: string },
  ): Promise<HolidayCalendar> {
    const existing = await this.repo.findCalendarById(id);
    if (!existing) throw new HolidayCalendarNotFoundError(id);

    const updated = await this.repo.updateCalendar(id, {
      name: patch.name?.trim(),
      description: patch.description?.trim(),
    });

    const revisions = await this.repo.listRevisions(id);
    const nextVersion = revisions.length + 1;
    await this._saveRevision(updated, nextVersion, patch.changedBy);
    return updated;
  }

  async deleteCalendar(id: string): Promise<void> {
    const existing = await this.repo.findCalendarById(id);
    if (!existing) throw new HolidayCalendarNotFoundError(id);
    await this.repo.deleteCalendar(id);
  }

  // ── Entries ────────────────────────────────────────────────────────────────

  async addEntry(
    calendarId: string,
    input: {
      name: string;
      startDate: string;
      endDate: string;
      recurring?: boolean;
      note?: string;
      changedBy?: string;
    },
  ): Promise<HolidayEntry> {
    const calendar = await this.repo.findCalendarById(calendarId);
    if (!calendar) throw new HolidayCalendarNotFoundError(calendarId);

    const newEntry = {
      name: input.name.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      recurring: input.recurring ?? false,
      note: input.note,
    };

    // Validate against existing entries
    const allEntries = [...calendar.entries, newEntry];
    const overlapErrors = detectEntryOverlaps(allEntries);
    if (overlapErrors.length > 0) {
      throw new HolidayCalendarValidationError(
        "Holiday entry overlaps with an existing entry",
        overlapErrors.map((msg) => ({ path: "entries", message: msg })),
      );
    }

    const entry = await this.repo.addEntry(calendarId, newEntry);

    // Snapshot the updated calendar
    const updatedCalendar = await this.repo.findCalendarById(calendarId);
    const revisions = await this.repo.listRevisions(calendarId);
    await this._saveRevision(updatedCalendar!, revisions.length + 1, input.changedBy, "Entry added");

    return entry;
  }

  async deleteEntry(calendarId: string, entryId: string, changedBy?: string): Promise<void> {
    const calendar = await this.repo.findCalendarById(calendarId);
    if (!calendar) throw new HolidayCalendarNotFoundError(calendarId);

    const entryExists = calendar.entries.some((e) => e.id === entryId);
    if (!entryExists) {
      throw new HolidayCalendarNotFoundError(`entry:${entryId}`);
    }

    await this.repo.deleteEntry(calendarId, entryId);

    const updatedCalendar = await this.repo.findCalendarById(calendarId);
    const revisions = await this.repo.listRevisions(calendarId);
    await this._saveRevision(updatedCalendar!, revisions.length + 1, changedBy, "Entry deleted");
  }

  // ── YAML import ────────────────────────────────────────────────────────────

  /**
   * Imports holidays from a validated YAML payload.
   *
   * Validation pipeline:
   *  1. Zod schema validation (types, required fields, date format)
   *  2. Date-order validation per entry (end_date >= start_date)
   *  3. Overlap detection across all entries in the import
   *  4. Overlap detection against any entries already in the calendar
   *
   * On success, the import REPLACES all existing entries for the calendar
   * (upsert-by-region semantics) and saves a new revision.
   *
   * @param rawPayload  The parsed YAML object (caller responsible for YAML→JS parsing)
   * @param options     changedBy / changeNote for the revision record
   */
  async importFromYaml(
    rawPayload: unknown,
    options: { changedBy?: string; changeNote?: string } = {},
  ): Promise<HolidayCalendar> {
    // 1. Schema validation
    const result = YamlImportSchema.safeParse(rawPayload);
    if (!result.success) {
      const details = result.error.errors.map((e) => ({
        path: e.path.join(".") || "root",
        message: e.message,
      }));
      throw new HolidayCalendarValidationError("YAML import failed schema validation", details);
    }

    const parsed = result.data;
    const region = parsed.region.trim().toLowerCase();

    // 2. Normalise entries
    const incomingEntries = parsed.holidays.map((h) => ({
      name: h.name.trim(),
      startDate: h.start_date,
      endDate: h.end_date,
      recurring: h.recurring ?? false,
      note: h.note,
    }));

    // 3. Overlap detection within the import itself
    const overlapErrors = detectEntryOverlaps(incomingEntries);
    if (overlapErrors.length > 0) {
      throw new HolidayCalendarValidationError(
        "YAML import contains overlapping date ranges",
        overlapErrors.map((msg) => ({ path: "holidays", message: msg })),
      );
    }

    // 4. Upsert calendar
    let calendar = await this.repo.findCalendarByRegion(region);
    let isNew = false;

    if (!calendar) {
      calendar = await this.repo.createCalendar({
        region,
        name: parsed.name ?? region,
        description: parsed.description,
      });
      isNew = true;
    } else if (parsed.name || parsed.description !== undefined) {
      calendar = await this.repo.updateCalendar(calendar.id, {
        name: parsed.name,
        description: parsed.description,
      });
    }

    // 5. Replace entries atomically
    await this.repo.replaceEntries(calendar.id, incomingEntries);

    // 6. Save revision
    const finalCalendar = await this.repo.findCalendarById(calendar.id);
    const revisions = await this.repo.listRevisions(calendar.id);
    const nextVersion = isNew ? 1 : revisions.length + 1;
    await this._saveRevision(
      finalCalendar!,
      nextVersion,
      options.changedBy,
      options.changeNote ?? "YAML import",
    );

    return finalCalendar!;
  }

  // ── Revisions ──────────────────────────────────────────────────────────────

  async listRevisions(calendarId: string): Promise<HolidayCalendarRevision[]> {
    const calendar = await this.repo.findCalendarById(calendarId);
    if (!calendar) throw new HolidayCalendarNotFoundError(calendarId);
    return this.repo.listRevisions(calendarId);
  }

  async getRevision(calendarId: string, version: number): Promise<HolidayCalendarRevision> {
    const calendar = await this.repo.findCalendarById(calendarId);
    if (!calendar) throw new HolidayCalendarNotFoundError(calendarId);

    const revision = await this.repo.getRevision(calendarId, version);
    if (!revision) {
      throw new HolidayCalendarNotFoundError(`revision v${version} for calendar ${calendarId}`);
    }
    return revision;
  }

  async rollbackToRevision(
    calendarId: string,
    version: number,
    changedBy?: string,
  ): Promise<HolidayCalendar> {
    const revision = await this.getRevision(calendarId, version);
    const snapshot = revision.snapshot;

    // Restore calendar metadata
    await this.repo.updateCalendar(calendarId, {
      name: snapshot.name,
      description: snapshot.description,
    });

    // Restore entries
    const entryInputs = snapshot.entries.map((e) => ({
      name: e.name,
      startDate: e.startDate,
      endDate: e.endDate,
      recurring: e.recurring,
      note: e.note,
    }));
    await this.repo.replaceEntries(calendarId, entryInputs);

    // Save a new revision recording the rollback
    const restoredCalendar = await this.repo.findCalendarById(calendarId);
    const revisions = await this.repo.listRevisions(calendarId);
    await this._saveRevision(
      restoredCalendar!,
      revisions.length + 1,
      changedBy,
      `Rolled back to version ${version}`,
    );

    return restoredCalendar!;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _saveRevision(
    calendar: HolidayCalendar,
    version: number,
    changedBy?: string,
    changeNote?: string,
  ): Promise<HolidayCalendarRevision> {
    return this.repo.saveRevision({
      calendarId: calendar.id,
      version,
      snapshot: calendar,
      changedBy,
      changeNote,
    });
  }
}

// ─── In-memory repository (for tests and local dev) ───────────────────────────

export class InMemoryHolidayCalendarRepository implements IHolidayCalendarRepository {
  private calendars = new Map<string, HolidayCalendar>();
  private entries = new Map<string, HolidayEntry[]>(); // calendarId → entries
  private revisions = new Map<string, HolidayCalendarRevision[]>(); // calendarId → revisions
  private _idCounter = 0;

  private newId(): string {
    return `hc-${++this._idCounter}-${Date.now()}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private buildCalendar(base: Omit<HolidayCalendar, "entries">): HolidayCalendar {
    return {
      ...base,
      entries: this.entries.get(base.id) ?? [],
    };
  }

  async createCalendar(input: { region: string; name: string; description?: string }): Promise<HolidayCalendar> {
    const id = this.newId();
    const now = this.now();
    const base: Omit<HolidayCalendar, "entries"> = {
      id,
      region: input.region,
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
    this.calendars.set(id, { ...base, entries: [] });
    this.entries.set(id, []);
    this.revisions.set(id, []);
    return this.buildCalendar(base);
  }

  async findCalendarById(id: string): Promise<HolidayCalendar | null> {
    const cal = this.calendars.get(id);
    if (!cal) return null;
    return this.buildCalendar(cal);
  }

  async findCalendarByRegion(region: string): Promise<HolidayCalendar | null> {
    for (const cal of this.calendars.values()) {
      if (cal.region === region) return this.buildCalendar(cal);
    }
    return null;
  }

  async listCalendars(): Promise<HolidayCalendar[]> {
    return Array.from(this.calendars.keys()).map((id) => {
      const cal = this.calendars.get(id)!;
      return this.buildCalendar(cal);
    });
  }

  async updateCalendar(id: string, patch: { name?: string; description?: string }): Promise<HolidayCalendar> {
    const cal = this.calendars.get(id);
    if (!cal) throw new Error(`Calendar ${id} not found`);
    if (patch.name !== undefined) cal.name = patch.name;
    if (patch.description !== undefined) cal.description = patch.description;
    cal.updatedAt = this.now();
    this.calendars.set(id, cal);
    return this.buildCalendar(cal);
  }

  async deleteCalendar(id: string): Promise<void> {
    this.calendars.delete(id);
    this.entries.delete(id);
    this.revisions.delete(id);
  }

  async addEntry(
    calendarId: string,
    entry: Omit<HolidayEntry, "id" | "calendarId" | "createdAt">,
  ): Promise<HolidayEntry> {
    const list = this.entries.get(calendarId) ?? [];
    const newEntry: HolidayEntry = {
      ...entry,
      id: this.newId(),
      calendarId,
      createdAt: this.now(),
    };
    list.push(newEntry);
    this.entries.set(calendarId, list);
    return newEntry;
  }

  async replaceEntries(
    calendarId: string,
    entries: Omit<HolidayEntry, "id" | "calendarId" | "createdAt">[],
  ): Promise<HolidayEntry[]> {
    const now = this.now();
    const newEntries: HolidayEntry[] = entries.map((e) => ({
      ...e,
      id: this.newId(),
      calendarId,
      createdAt: now,
    }));
    this.entries.set(calendarId, newEntries);
    return newEntries;
  }

  async deleteEntry(calendarId: string, entryId: string): Promise<void> {
    const list = this.entries.get(calendarId) ?? [];
    this.entries.set(
      calendarId,
      list.filter((e) => e.id !== entryId),
    );
  }

  async saveRevision(revision: Omit<HolidayCalendarRevision, "id" | "createdAt">): Promise<HolidayCalendarRevision> {
    const list = this.revisions.get(revision.calendarId) ?? [];
    const newRevision: HolidayCalendarRevision = {
      ...revision,
      // Deep-clone the snapshot so future mutations to entries don't retroactively
      // change stored historical versions.
      snapshot: JSON.parse(JSON.stringify(revision.snapshot)),
      id: this.newId(),
      createdAt: this.now(),
    };
    list.push(newRevision);
    this.revisions.set(revision.calendarId, list);
    return newRevision;
  }

  async listRevisions(calendarId: string): Promise<HolidayCalendarRevision[]> {
    return [...(this.revisions.get(calendarId) ?? [])].sort((a, b) => b.version - a.version);
  }

  async getRevision(calendarId: string, version: number): Promise<HolidayCalendarRevision | null> {
    const list = this.revisions.get(calendarId) ?? [];
    return list.find((r) => r.version === version) ?? null;
  }

  /** Convenience: reset all state between tests */
  reset(): void {
    this.calendars.clear();
    this.entries.clear();
    this.revisions.clear();
    this._idCounter = 0;
  }
}

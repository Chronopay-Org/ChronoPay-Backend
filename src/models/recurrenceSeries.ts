/**
 * recurrenceSeries.ts
 *
 * Domain model for recurrence series — the persistent representation of an RRULE
 * recurring pattern. Each series has a version that is bumped on edit so
 * materialized occurrences from stale versions can be invalidated.
 */

export interface RecurrenceSeries {
  id: string;
  rrule: string;
  /** Monotonically-incrementing version. Bumped on every RRULE edit. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateRecurrenceSeriesInput {
  rrule: string;
}

export interface RecurrenceSeriesRepository {
  create(input: CreateRecurrenceSeriesInput): Promise<RecurrenceSeries>;
  findById(id: string): Promise<RecurrenceSeries | null>;
  /** Updates the RRULE and bumps the version atomically. */
  updateRRule(id: string, rrule: string): Promise<RecurrenceSeries | null>;
  listAll(): Promise<RecurrenceSeries[]>;
  delete(id: string): Promise<boolean>;
}

// ── In-memory implementation (for tests) ────────────────────────────────────

const cloneSeries = (s: RecurrenceSeries): RecurrenceSeries => ({ ...s });

let idCounter = 1;
const store: RecurrenceSeries[] = [];

export class InMemoryRecurrenceSeriesRepository implements RecurrenceSeriesRepository {
  async create(input: CreateRecurrenceSeriesInput): Promise<RecurrenceSeries> {
    const now = Date.now();
    const series: RecurrenceSeries = {
      id: `series-${idCounter++}`,
      rrule: input.rrule,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    store.push(series);
    return cloneSeries(series);
  }

  async findById(id: string): Promise<RecurrenceSeries | null> {
    const found = store.find((s) => s.id === id);
    return found ? cloneSeries(found) : null;
  }

  async updateRRule(id: string, rrule: string): Promise<RecurrenceSeries | null> {
    const index = store.findIndex((s) => s.id === id);
    if (index === -1) return null;

    const now = Date.now();
    store[index] = {
      ...store[index],
      rrule,
      version: store[index].version + 1,
      updatedAt: now,
    };
    return cloneSeries(store[index]);
  }

  async listAll(): Promise<RecurrenceSeries[]> {
    return store.map(cloneSeries);
  }

  async delete(id: string): Promise<boolean> {
    const index = store.findIndex((s) => s.id === id);
    if (index === -1) return false;
    store.splice(index, 1);
    return true;
  }

  /** Resets the store — for test isolation. */
  reset(): void {
    store.splice(0, store.length);
    idCounter = 1;
  }
}

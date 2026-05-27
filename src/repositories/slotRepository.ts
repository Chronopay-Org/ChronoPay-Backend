/**
 * slotRepository.ts
 *
 * Two implementations of ISlotRepository:
 *  - PgSlotRepository  — PostgreSQL-backed, used in production.
 *  - InMemorySlotRepository — in-memory, used in tests and legacy list routes.
 *
 * The DB schema (migration 002) stores times as TIMESTAMPTZ.
 * SlotService works with Unix-ms integers, so we convert at the boundary:
 *   write: ms → new Date(ms)  (pg serialises to TIMESTAMPTZ)
 *   read:  TIMESTAMPTZ → .getTime() → ms
 *
 * Conflict detection relies on the EXCLUDE constraint added by migration 003.
 * PgSlotRepository.hasConflict() runs a lightweight range-overlap query so
 * SlotService can return a fast 409 before attempting the INSERT/UPDATE.
 */

import { query } from "../db/pool.js";
import { Slot } from "../types.js";

// ─── Repository interface ─────────────────────────────────────────────────────

export interface SlotInput {
  professional: string;
  startTime: number; // Unix ms
  endTime: number;   // Unix ms
}

export interface SlotRecord {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt: string;
  updatedAt: string;
}

export interface ISlotRepository {
  create(input: SlotInput): Promise<SlotRecord>;
  findById(id: number): Promise<SlotRecord | null>;
  list(): Promise<SlotRecord[]>;
  update(id: number, patch: Partial<SlotInput>): Promise<SlotRecord | null>;
  delete(id: number): Promise<boolean>;
  /**
   * Returns true if any slot for the same professional overlaps [startTime, endTime).
   * Adjacency (end == start) is NOT a conflict.
   * Pass excludeId to ignore a specific slot (used during updates).
   */
  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: number,
  ): Promise<boolean>;
}

// ─── PostgreSQL implementation ────────────────────────────────────────────────

/**
 * Maps a raw DB row to SlotRecord (converts TIMESTAMPTZ → Unix ms).
 */
function rowToRecord(row: Record<string, unknown>): SlotRecord {
  return {
    id: row.id as number,
    professional: row.professional as string,
    startTime: (row.start_time as Date).getTime(),
    endTime: (row.end_time as Date).getTime(),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export class PgSlotRepository implements ISlotRepository {
  async create(input: SlotInput): Promise<SlotRecord> {
    const { rows } = await query(
      `INSERT INTO slots (professional, start_time, end_time, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING id, professional, start_time, end_time, created_at, updated_at`,
      [input.professional, new Date(input.startTime), new Date(input.endTime)],
    );
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async findById(id: number): Promise<SlotRecord | null> {
    const { rows } = await query(
      `SELECT id, professional, start_time, end_time, created_at, updated_at
       FROM slots WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async list(): Promise<SlotRecord[]> {
    const { rows } = await query(
      `SELECT id, professional, start_time, end_time, created_at, updated_at
       FROM slots ORDER BY start_time ASC`,
    );
    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  async update(id: number, patch: Partial<SlotInput>): Promise<SlotRecord | null> {
    // Build SET clause dynamically from provided fields only.
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (patch.professional !== undefined) {
      sets.push(`professional = $${idx++}`);
      params.push(patch.professional);
    }
    if (patch.startTime !== undefined) {
      sets.push(`start_time = $${idx++}`);
      params.push(new Date(patch.startTime));
    }
    if (patch.endTime !== undefined) {
      sets.push(`end_time = $${idx++}`);
      params.push(new Date(patch.endTime));
    }

    if (sets.length === 0) return this.findById(id);

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await query(
      `UPDATE slots SET ${sets.join(", ")}
       WHERE id = $${idx}
       RETURNING id, professional, start_time, end_time, created_at, updated_at`,
      params,
    );
    if (rows.length === 0) return null;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async delete(id: number): Promise<boolean> {
    const { rowCount } = await query(`DELETE FROM slots WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: number,
  ): Promise<boolean> {
    const { rows } = await query(
      `SELECT 1 FROM slots
       WHERE professional = $1
         AND id IS DISTINCT FROM $4
         AND start_time < $3
         AND end_time   > $2
       LIMIT 1`,
      [professional, new Date(startTime), new Date(endTime), excludeId ?? null],
    );
    return rows.length > 0;
  }
}

// ─── In-memory implementation (tests + legacy list routes) ───────────────────

export class InMemorySlotRepository implements ISlotRepository {
  private slots: SlotRecord[] = [];
  private nextId = 1;

  async create(input: SlotInput): Promise<SlotRecord> {
    const now = new Date().toISOString();
    const slot: SlotRecord = {
      id: this.nextId++,
      professional: input.professional,
      startTime: input.startTime,
      endTime: input.endTime,
      createdAt: now,
      updatedAt: now,
    };
    this.slots.push(slot);
    return { ...slot };
  }

  async findById(id: number): Promise<SlotRecord | null> {
    return this.slots.find((s) => s.id === id) ?? null;
  }

  async list(): Promise<SlotRecord[]> {
    return this.slots.map((s) => ({ ...s }));
  }

  async update(id: number, patch: Partial<SlotInput>): Promise<SlotRecord | null> {
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const existing = this.slots[idx];
    const updated: SlotRecord = {
      ...existing,
      ...(patch.professional !== undefined && { professional: patch.professional }),
      ...(patch.startTime !== undefined && { startTime: patch.startTime }),
      ...(patch.endTime !== undefined && { endTime: patch.endTime }),
      updatedAt: new Date().toISOString(),
    };
    this.slots[idx] = updated;
    return { ...updated };
  }

  async delete(id: number): Promise<boolean> {
    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.slots.splice(idx, 1);
    return true;
  }

  async hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: number,
  ): Promise<boolean> {
    return this.slots.some(
      (s) =>
        s.professional === professional &&
        s.id !== excludeId &&
        s.startTime < endTime &&
        s.endTime > startTime,
    );
  }

  /** Test helper — reset state between tests. */
  reset(): void {
    this.slots = [];
    this.nextId = 1;
  }
}

// ─── Legacy functional API (kept for backward compatibility with list routes) ─

const _legacySlots: Slot[] = Array.from({ length: 125 }, (_, idx) => ({
  id: `slot-${idx + 1}`,
  title: `Slot ${idx + 1}`,
  startsAt: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  endsAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  available: idx % 2 === 0,
  _internalNote: "do not expose",
}));

export const getSlotsCount = async (): Promise<number> => _legacySlots.length;

export const getSlotsPage = async (offset: number, limit: number): Promise<Slot[]> => {
  if (offset < 0 || limit < 0) throw new Error("Invalid pagination parameters");
  return _legacySlots.slice(offset, offset + limit);
};

export const __test__clearSlots = (): void => {};

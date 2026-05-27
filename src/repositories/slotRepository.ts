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

// In-memory slot store for demo. In real world this would be DB query layer.
const slots: Slot[] = Array.from({ length: 125 }, (_, idx) => ({
  id: idx + 1,
  professional: `Professional ${idx + 1}`,
  startTime: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  endTime: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  _internalNote: "do not expose",
}));

export const getSlotsCount = async (): Promise<number> => _legacySlots.length;

export const getSlotsPage = async (offset: number, limit: number): Promise<Slot[]> => {
  if (offset < 0 || limit < 0) throw new Error("Invalid pagination parameters");
  return _legacySlots.slice(offset, offset + limit);
};

export const __test__clearSlots = (): void => {};

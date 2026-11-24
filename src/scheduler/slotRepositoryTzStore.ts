/**
 * slotRepositoryTzStore.ts
 *
 * Adapts the live slot repository to the `listPage` / `size` interface that
 * the timezone drift monitor scans (`Pick<InMemorySlotStore, "listPage" | "size">`).
 *
 * Paging is by id cursor: rows are ordered by id and each page starts at the
 * first id strictly greater than the cursor, so a slot is never skipped or
 * repeated across pages. The same comparator is used for ordering and for the
 * cursor test so the two can never disagree.
 *
 * NOTE: the in-memory slot repository only exposes `list()`, so each page
 * still copies and sorts the whole set. A database-backed repository should
 * replace this with `WHERE id > $cursor ORDER BY id LIMIT $n`.
 */

import type { SlotRecord } from "../modules/slots/slot-repository.js";
import type { TZSlotRecord } from "./tzDriftMonitor.js";

export type SlotListSource = { list(): SlotRecord[] };

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toTzSlotRecord(slot: SlotRecord): TZSlotRecord {
  return {
    id: String(slot.id),
    professionalId: slot.professional,
    startTime: slot.startTime,
    endTime: slot.endTime,
    createdAt: slot.createdAt,
  };
}

export class SlotRepositoryTzStore {
  constructor(private readonly repository: SlotListSource) {}

  /**
   * @param cursor Last slot id of the previous page, or undefined for the first page.
   * @param limit  Maximum rows to return.
   * @returns The page plus the cursor for the next one (undefined on the last page).
   */
  listPage(
    cursor?: string,
    limit: number = 100,
  ): { slots: TZSlotRecord[]; nextCursor?: string } {
    const sorted = this.repository
      .list()
      .map(toTzSlotRecord)
      .sort((a, b) => compareIds(a.id, b.id));

    const remaining =
      cursor === undefined ? sorted : sorted.filter((s) => compareIds(s.id, cursor) > 0);

    const slots = remaining.slice(0, limit);
    const nextCursor =
      remaining.length > slots.length ? slots[slots.length - 1].id : undefined;

    return { slots, nextCursor };
  }

  size(): number {
    return this.repository.list().length;
  }
}

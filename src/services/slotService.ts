import { getSlotsCount, getSlotsAfter, encodeCursor, decodeCursor } from "../repositories/slotRepository.js";

export const MAX_LIMIT = 100;

export async function listSlotsCursor(opts: { cursor: string | null; limit: number; sort: "asc" | "desc" }) {
  const { cursor, limit, sort } = opts;
  const total = await getSlotsCount();

  const decoded = cursor ? decodeCursor(cursor) : null;
  const data = await getSlotsAfter({ cursor: decoded, limit, sort });

  const nextCursor = data.length === limit ? encodeCursor(data[data.length - 1]) : null;

  return { data, total, nextCursor };
}

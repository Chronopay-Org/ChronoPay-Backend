type Slot = {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
};

const SLOTS: Slot[] = Array.from({ length: 250 }).map((_, i) => {
  const start = 1000 + i * 60;
  return {
    id: i + 1,
    professional: `pro-${(i % 5) + 1}`,
    startTime: start,
    endTime: start + 30,
  };
});

export async function getSlotsCount() {
  return SLOTS.length;
}

export function encodeCursor(slot: Slot) {
  return Buffer.from(`${slot.startTime}:${slot.id}`).toString("base64");
}

export function decodeCursor(cursor: string) {
  try {
    const raw = Buffer.from(cursor, "base64").toString();
    const [start, id] = raw.split(":");
    return { startTime: Number(start), id: Number(id) };
  } catch {
    return null;
  }
}

export async function getSlotsAfter(opts: { cursor: { startTime: number; id: number } | null; limit: number; sort: "asc" | "desc" }) {
  const { cursor, limit, sort } = opts;
  const cloned = SLOTS.slice();
  cloned.sort((a, b) => (sort === "asc" ? a.startTime - b.startTime || a.id - b.id : b.startTime - a.startTime || b.id - a.id));

  if (!cursor) {
    return cloned.slice(0, limit);
  }

  const idx = cloned.findIndex((slot) => {
    if (sort === "asc") {
      return slot.startTime > cursor.startTime || (slot.startTime === cursor.startTime && slot.id > cursor.id);
    }

    return slot.startTime < cursor.startTime || (slot.startTime === cursor.startTime && slot.id < cursor.id);
  });

  if (idx === -1) {
    return [];
  }

  return cloned.slice(idx, idx + limit);
}

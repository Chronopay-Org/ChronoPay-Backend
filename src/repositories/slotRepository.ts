import { Slot } from "../types.js";

// In-memory slot store for demo. In real world this would be DB query layer.
const slots: Slot[] = Array.from({ length: 125 }, (_, idx) => ({
  id: idx + 1,
  professional: `Professional ${idx + 1}`,
  startTime: new Date(Date.UTC(2026, 0, 1, 8, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  endTime: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + idx * 60 * 60 * 1000).toISOString(),
  _internalNote: "do not expose",
}));

export const getSlotsCount = async (): Promise<number> => {
  // Simulate DB count query
  return slots.length;
};

export const getSlotsPage = async (offset: number, limit: number): Promise<Slot[]> => {
  // Simulate safe DB query with offset/limit
  if (offset < 0 || limit < 0) {
    throw new Error("Invalid pagination parameters");
  }

  const pageSlice = slots.slice(offset, offset + limit);
  return pageSlice;
};

// For testing only: reset or override data
export const __test__clearSlots = (): void => {
  // not used in production
};

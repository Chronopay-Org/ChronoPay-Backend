export interface SlotRecord {
  id: string;
  professional: string;
  startTime: number;
  endTime: number;
  bookable: boolean;
}

export interface SlotRepository {
  list(): SlotRecord[];
  findById(slotId: string): SlotRecord | undefined;
  /**
   * Returns true if any existing slot for the same professional overlaps
   * [startTime, endTime). Adjacency (end == start) is NOT a conflict.
   * Optionally excludes a slot by id (used during updates).
   */
  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: string,
  ): boolean;
}

const DEFAULT_SLOTS: SlotRecord[] = [
  {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: true,
  },
  {
    id: "slot-22222222-2222-4222-8222-222222222222",
    professional: "bob",
    startTime: 1_900_000_720_000,
    endTime: 1_900_001_080_000,
    bookable: true,
  },
  {
    id: "slot-33333333-3333-4333-8333-333333333333",
    professional: "charlie",
    startTime: 1_900_001_440_000,
    endTime: 1_900_001_800_000,
    bookable: false,
  },
];

export class InMemorySlotRepository implements SlotRepository {
  private readonly slots: SlotRecord[];

  constructor(seedSlots: SlotRecord[] = DEFAULT_SLOTS) {
    this.slots = seedSlots.map((slot) => ({ ...slot }));
  }

  list(): SlotRecord[] {
    return this.slots.map((slot) => ({ ...slot }));
  }

  findById(slotId: string): SlotRecord | undefined {
    const slot = this.slots.find((entry) => entry.id === slotId);
    return slot ? { ...slot } : undefined;
  }

  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: string,
  ): boolean {
    return this.slots.some(
      (s) =>
        s.professional === professional &&
        s.id !== excludeId &&
        s.startTime < endTime &&
        s.endTime > startTime,
    );
  }
}

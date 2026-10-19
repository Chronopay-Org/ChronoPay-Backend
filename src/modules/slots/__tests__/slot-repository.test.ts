import { InMemorySlotRepository, type SlotRecord } from "../slot-repository.js";

describe("InMemorySlotRepository.updateBookable", () => {
  const slot: SlotRecord = {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "alice",
    startTime: 1_900_000_000_000,
    endTime: 1_900_000_360_000,
    bookable: false,
  };

  it("updates and returns the bookable state for an existing slot", () => {
    const repository = new InMemorySlotRepository([slot]);

    repository.updateBookable(slot.id, true);

    expect(repository.findById(slot.id)?.bookable).toBe(true);
  });

  it.each(["missing-slot", ""])("throws the not-found error for slot id %j", (slotId) => {
    const repository = new InMemorySlotRepository([slot]);

    expect(() => repository.updateBookable(slotId, true)).toThrow(new Error(`Slot ${slotId} not found`));
    expect(repository.findById(slot.id)?.bookable).toBe(false);
  });
});
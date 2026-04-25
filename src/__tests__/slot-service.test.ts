import {
  SlotNotFoundError,
  SlotService,
  SlotValidationError,
} from "../services/slotService.js";

describe.skip("SlotService", () => {
  let currentTime = Date.parse("2026-03-28T00:00:00.000Z");
  let service: SlotService;

  beforeEach(() => {
    currentTime = Date.parse("2026-03-28T00:00:00.000Z");
    service = new SlotService(undefined, () => new Date(currentTime));
  });

  it("creates slots and returns a sorted list", async () => {
    const first = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    currentTime += 1000;

    const second = service.createSlot({
      professional: "bob",
      startTime: 3000,
      endTime: 4000,
    });

    const list = (await service.listSlots()).slots;

    expect(list.map((slot: any) => slot.id)).toEqual([first.id, second.id]);
    list[0].professional = "tampered";
    expect((await service.listSlots()).slots[0].professional).toBe("alice");
  });

  it("throws when updating with invalid payload type", () => {
    const slot = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(() => service.updateSlot(slot.id, null as unknown as { professional: string })).toThrow(
      SlotValidationError,
    );
  });

  it("throws when professional update has invalid type", () => {
    const slot = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(() =>
      service.updateSlot(slot.id, { professional: 123 as unknown as string }),
    ).toThrow("professional must be a string");
  });

  it("throws when range update has non-finite values", () => {
    const slot = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    expect(() => service.updateSlot(slot.id, { startTime: Number.NaN })).toThrow(
      "startTime and endTime must be finite numbers",
    );
  });

  it("throws not found for unknown slot", () => {
    expect(() => service.updateSlot(999, { endTime: 1000 })).toThrow(SlotNotFoundError);
  });

  it("resets all state", async () => {
    service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    service.reset();

    expect((await service.listSlots()).slots).toEqual([]);
    const recreated = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });
    expect(recreated.id).toBe(1);
  });
});
import { Slot } from "../types.js";
import {
  SlotNotFoundError,
  SlotService,
  SlotValidationError,
} from "../services/slotService.js";

describe("SlotService", () => {
  let currentTime = Date.parse("2026-03-28T00:00:00.000Z");
  let service: SlotService;

  beforeEach(() => {
    currentTime = Date.parse("2026-03-28T00:00:00.000Z");
    service = new SlotService(() => new Date(currentTime));
  });

  it("creates slots and returns a sorted list", () => {
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

    const list = service.listSlots() as any[];

    expect(list.map((slot: Slot) => slot.id)).toEqual([first.id, second.id]);
    list[0].professional = "tampered";
    expect((service.listSlots() as any)[0].professional).toBe("alice");
  });

  it("returns the second slot for page 2 of a paginated list", () => {
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

    const page2 = service.listSlots({ page: 2, limit: 1 });

    expect(page2.map((slot: Slot) => slot.id)).toEqual([second.id]);
    expect(page2.map((slot: Slot) => slot.id)).not.toContain(first.id);
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

  it("removes a slot by id", () => {
    const slot = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    service.deleteSlot(slot.id);

    expect(service.listSlots()).toEqual([]);
  });

  it("resets all state", () => {
    service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });

    service.reset();

    expect(service.listSlots()).toEqual([]);
    const recreated = service.createSlot({
      professional: "alice",
      startTime: 1000,
      endTime: 2000,
    });
    expect(recreated.id).toBe(1);
  });
});

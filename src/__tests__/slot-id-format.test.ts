import { BookingIntentError, parseCreateBookingIntentBody, SLOT_ID_PATTERN } from "../modules/booking-intents/booking-intent-service.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { SlotService } from "../services/slotService.js";

describe("Slot id contract", () => {
  const canonicalSlotId = "slot-11111111-1111-4111-8111-111111111111";

  it("accepts valid canonical slot ids", () => {
    const input = parseCreateBookingIntentBody({ slotId: canonicalSlotId });

    expect(input).toEqual({ slotId: canonicalSlotId });
  });

  it("rejects numeric-style slot ids", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "12345" })).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody({ slotId: "12345" })).toThrow("slotId format is invalid.");
  });

  it("rejects prefixed id edge cases", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-12345678-1234-1234-1234-12345678901" }))
      .toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-12345678-1234-1234-1234-12345678901" }))
      .toThrow("slotId format is invalid.");
  });

  it("rejects oversized slot ids", () => {
    const oversizedSlotId = `slot-${"a".repeat(100)}`;
    expect(() => parseCreateBookingIntentBody({ slotId: oversizedSlotId })).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody({ slotId: oversizedSlotId })).toThrow("slotId format is invalid.");
  });

  it("rejects empty slot ids", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "" })).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody({ slotId: "" })).toThrow("slotId is required.");
  });

  it("generates canonical slot ids in SlotService", () => {
    const slotService = new SlotService();
    const slot = slotService.createSlot({ professional: "alice", startTime: 1_900_000_000_000, endTime: 1_900_000_360_000 });

    // @ts-expect-error - Auto-fixed by script
    expect(SLOT_ID_PATTERN.test(slot.id)).toBe(true);
    // @ts-expect-error - Auto-fixed by script
    expect(slot.id.startsWith("slot-")).toBe(true);
  });

  it("uses canonical slot ids in InMemorySlotRepository default slots", () => {
    const repository = new InMemorySlotRepository();
    const slots = repository.list();

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => SLOT_ID_PATTERN.test(slot.id))).toBe(true);
    expect(repository.findById(canonicalSlotId)).toBeDefined();
  });
});

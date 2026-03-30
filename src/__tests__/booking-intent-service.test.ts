import {
  BookingIntentError,
  BookingIntentService,
  parseCreateBookingIntentBody,
} from "../modules/booking-intents/booking-intent-service.js";
import { InMemoryBookingIntentRepository } from "../modules/booking-intents/booking-intent-repository.js";
import { InMemorySlotRepository } from "../modules/slots/slot-repository.js";

describe("BookingIntentService", () => {
  it("creates a booking intent from slot-derived values", () => {
    const service = new BookingIntentService(
      new InMemoryBookingIntentRepository(),
      new InMemorySlotRepository(),
      () => "2026-01-01T00:00:00.000Z",
    );

    const intent = service.createIntent(
      { slotId: "slot-100", note: "Window seat please" },
      { userId: "customer-1", role: "customer" },
    );

    expect(intent.id).toBe("intent-1");
    expect(intent.customerId).toBe("customer-1");
    expect(intent.professional).toBe("alice");
    expect(intent.startTime).toBe(1_900_000_000_000);
    expect(intent.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects not found, unbookable, self-booking, and duplicates", () => {
    const repository = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(repository, new InMemorySlotRepository());

    expect(() =>
      service.createIntent({ slotId: "slot-missing" }, { userId: "customer-1", role: "customer" }),
    ).toThrow(new BookingIntentError(404, "Selected slot was not found."));

    expect(() =>
      service.createIntent({ slotId: "slot-102" }, { userId: "customer-1", role: "customer" }),
    ).toThrow(new BookingIntentError(409, "Selected slot is not bookable."));

    expect(() =>
      service.createIntent({ slotId: "slot-100" }, { userId: "alice", role: "customer" }),
    ).toThrow(new BookingIntentError(403, "You cannot create a booking intent for your own slot."));

    service.createIntent({ slotId: "slot-100" }, { userId: "customer-1", role: "customer" });

    expect(() =>
      service.createIntent({ slotId: "slot-100" }, { userId: "customer-1", role: "customer" }),
    ).toThrow(new BookingIntentError(409, "A booking intent already exists for this slot."));
  });

  it("rejects a conflicting intent from a second customer for the same slot", () => {
    const repository = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(repository, new InMemorySlotRepository());

    service.createIntent({ slotId: "slot-101" }, { userId: "customer-1", role: "customer" });

    expect(() =>
      service.createIntent({ slotId: "slot-101" }, { userId: "customer-2", role: "customer" }),
    ).toThrow(new BookingIntentError(409, "Selected slot already has an active booking intent."));
  });
});

describe("parseCreateBookingIntentBody", () => {
  it("accepts the minimal valid payload and trims note values", () => {
    expect(parseCreateBookingIntentBody({ slotId: "slot-100" })).toEqual({
      slotId: "slot-100",
    });

    expect(parseCreateBookingIntentBody({ slotId: " slot-100 ", note: " hello " })).toEqual({
      slotId: "slot-100",
      note: "hello",
    });
  });

  it("rejects malformed payloads and invalid fields", () => {
    expect(() => parseCreateBookingIntentBody(null)).toThrow(
      new BookingIntentError(400, "Booking intent payload must be a JSON object."),
    );
    expect(() => parseCreateBookingIntentBody({})).toThrow(
      new BookingIntentError(400, "slotId is required."),
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "bad!" })).toThrow(
      new BookingIntentError(400, "slotId format is invalid."),
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-100", note: "" })).toThrow(
      new BookingIntentError(400, "note cannot be empty when provided."),
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-100", note: 123 })).toThrow(
      new BookingIntentError(400, "note must be a string when provided."),
    );
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "slot-100", note: "x".repeat(501) }),
    ).toThrow(new BookingIntentError(400, "note must be 500 characters or fewer."));
  });
});

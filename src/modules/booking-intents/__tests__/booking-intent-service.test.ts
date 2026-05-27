import { jest } from "@jest/globals";
import { BookingIntentService, BookingIntentError, parseCreateBookingIntentBody } from "../booking-intent-service.js";
import { BookingIntentRepository } from "../booking-intent-repository.js";
import { SlotRepository } from "../../slots/slot-repository.js";

describe("BookingIntentService", () => {
  let service: BookingIntentService;
  let mockRepo: jest.Mocked<BookingIntentRepository>;
  let mockSlotRepo: jest.Mocked<SlotRepository>;

  beforeEach(() => {
    mockRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      findBySlotId: jest.fn(),
      findBySlotIdAndCustomer: jest.fn(),
      updateTokenInfo: jest.fn(),
    } as any;

    mockSlotRepo = {
      list: jest.fn(),
      findById: jest.fn(),
      hasConflict: jest.fn(),
    } as any;

    service = new BookingIntentService(mockRepo, mockSlotRepo, () => "2026-01-01T00:00:00.000Z");
  });

  describe("createIntent", () => {
    const input = { slotId: "slot-1", note: "some note" };
    const actor = { userId: "user-1", role: "customer" as const };
    const slot = {
      id: "slot-1",
      professional: "prof-1",
      startTime: 1000,
      endTime: 2000,
      bookable: true,
    };

    it("creates an intent successfully", async () => {
      mockSlotRepo.findById.mockReturnValue(slot);
      mockRepo.findBySlotIdAndCustomer.mockResolvedValue(undefined);
      mockRepo.findBySlotId.mockResolvedValue(undefined);
      mockRepo.create.mockResolvedValue({
        id: "intent-1",
        slotId: slot.id,
        professional: slot.professional,
        customerId: actor.userId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const result = await service.createIntent(input, actor);

      expect(result.id).toBe("intent-1");
      expect(mockRepo.create).toHaveBeenCalled();
    });

    it("throws 404 if slot not found", async () => {
      mockSlotRepo.findById.mockReturnValue(undefined);

      await expect(service.createIntent(input, actor)).rejects.toThrow(
        new BookingIntentError(404, "Selected slot was not found."),
      );
    });

    it("throws 409 if slot not bookable", async () => {
      mockSlotRepo.findById.mockReturnValue({ ...slot, bookable: false });

      await expect(service.createIntent(input, actor)).rejects.toThrow(
        new BookingIntentError(409, "Selected slot is not bookable."),
      );
    });

    it("throws 403 if professional tries to book own slot", async () => {
      mockSlotRepo.findById.mockReturnValue({ ...slot, professional: actor.userId });

      await expect(service.createIntent(input, actor)).rejects.toThrow(
        new BookingIntentError(403, "You cannot create a booking intent for your own slot."),
      );
    });

    it("throws 409 if customer already has an intent for this slot", async () => {
      mockSlotRepo.findById.mockReturnValue(slot);
      mockRepo.findBySlotIdAndCustomer.mockResolvedValue({ id: "existing" } as any);

      await expect(service.createIntent(input, actor)).rejects.toThrow(
        new BookingIntentError(409, "A booking intent already exists for this slot."),
      );
    });

    it("throws 409 if slot already has an active intent", async () => {
      mockSlotRepo.findById.mockReturnValue(slot);
      mockRepo.findBySlotIdAndCustomer.mockResolvedValue(undefined);
      mockRepo.findBySlotId.mockResolvedValue({ id: "existing" } as any);

      await expect(service.createIntent(input, actor)).rejects.toThrow(
        new BookingIntentError(409, "Selected slot already has an active booking intent."),
      );
    });
  });
});

describe("parseCreateBookingIntentBody", () => {
  it("parses valid body with note", () => {
    const body = { slotId: "slot-123", note: "some note" };
    const result = parseCreateBookingIntentBody(body);
    expect(result).toEqual({ slotId: "slot-123", note: "some note" });
  });

  it("parses valid body without note", () => {
    const body = { slotId: "slot-123" };
    const result = parseCreateBookingIntentBody(body);
    expect(result).toEqual({ slotId: "slot-123" });
  });

  it("trims slotId and note", () => {
    const body = { slotId: "  slot-123  ", note: "  some note  " };
    const result = parseCreateBookingIntentBody(body);
    expect(result).toEqual({ slotId: "slot-123", note: "some note" });
  });

  it("throws 400 if body is not an object", () => {
    expect(() => parseCreateBookingIntentBody(null)).toThrow(
      new BookingIntentError(400, "Booking intent payload must be a JSON object."),
    );
  });

  it("throws 400 if slotId is missing", () => {
    expect(() => parseCreateBookingIntentBody({})).toThrow(
      new BookingIntentError(400, "slotId is required."),
    );
  });

  it("throws 400 if slotId format is invalid", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "!!!" })).toThrow(
      new BookingIntentError(400, "slotId format is invalid."),
    );
  });

  it("throws 400 if note is not a string", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-1", note: 123 })).toThrow(
      new BookingIntentError(400, "note must be a string when provided."),
    );
  });

  it("throws 400 if note is empty", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-1", note: "  " })).toThrow(
      new BookingIntentError(400, "note cannot be empty when provided."),
    );
  });

  it("throws 400 if note is too long", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "slot-1", note: "a".repeat(501) })).toThrow(
      new BookingIntentError(400, "note must be 500 characters or fewer."),
    );
  });
});

import { jest } from "@jest/globals";
import { BookingIntentService } from "../booking-intent-service.js";

describe("BookingIntentService recurring", () => {
  let service: BookingIntentService;
  let mockRepo: any;
  let mockSlotRepo: any;

  beforeEach(() => {
    mockRepo = {
      create: jest.fn().mockImplementation(async (rec) => ({ id: `intent-${Math.random()}`, ...rec })),
      findById: jest.fn(),
      findBySlotId: jest.fn().mockReturnValue(undefined),
      findBySlotIdAndCustomer: jest.fn().mockReturnValue(undefined),
      updateTokenInfo: jest.fn(),
    };

    // One slot matching the DTSTART
    const dt = new Date("2026-01-05T10:00:00.000Z").getTime();
    mockSlotRepo = {
      list: jest.fn().mockReturnValue([
        { id: "slot-1", professional: "alice", startTime: dt, endTime: dt + 3600000, bookable: true },
      ]),
      findById: jest.fn(),
      hasConflict: jest.fn(),
      updateBookable: jest.fn(),
    };

    service = new BookingIntentService(mockRepo, mockSlotRepo, () => "2026-01-01T00:00:00.000Z");
  });

  it("creates intents for bounded rrule occurrences", async () => {
    const rrule = "DTSTART:20260105T100000Z\nRRULE:FREQ=WEEKLY;COUNT=1;BYDAY=MO";
    const actor = { userId: "buyer-1", role: "customer", claims: {} };

    const report = await service.createRecurringIntents({ rrule }, actor as any);
    expect(report.successes.length).toBe(1);
    expect(report.failures.length).toBe(0);
  });
});

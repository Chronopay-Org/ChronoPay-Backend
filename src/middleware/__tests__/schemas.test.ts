import { CreateBookingIntentBodySchema, CreateSlotBodySchema, type CreateSlotBody } from "../schemas.js";

describe("CreateSlotBodySchema", () => {
  const minimalPayload: CreateSlotBody = {
    professional: "p",
    startTime: 0,
    endTime: 0,
  };

  it("accepts the minimum valid payload and preserves its values", () => {
    expect(CreateSlotBodySchema.parse(minimalPayload)).toEqual(minimalPayload);
  });

  it("accepts a realistic payload with epoch and ISO-8601 times", () => {
    const payload = {
      professional: "dr-smith",
      startTime: 1_735_732_800_000,
      endTime: "2024-12-08T11:00:00.000Z",
    };

    expect(CreateSlotBodySchema.safeParse(payload)).toEqual({ success: true, data: payload });
  });

  it.each(["professional", "startTime", "endTime"])("requires %s", (field) => {
    const payload = { ...minimalPayload };
    delete payload[field as keyof typeof payload];

    const result = CreateSlotBodySchema.safeParse(payload);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
  });

  it("rejects an empty professional", () => {
    const result = CreateSlotBodySchema.safeParse({ ...minimalPayload, professional: "" });

    expect(result.success).toBe(false);
  });

  it.each([
    ["startTime", "not-a-date"],
    ["endTime", ""],
    ["startTime", Number.NaN],
    ["endTime", Number.POSITIVE_INFINITY],
  ])("rejects an invalid %s value", (field, value) => {
    const result = CreateSlotBodySchema.safeParse({ ...minimalPayload, [field]: value });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
  });

  it("strips unknown fields without changing the public parsed shape", () => {
    const result = CreateSlotBodySchema.parse({ ...minimalPayload, injected: "ignored" });

    expect(result).toEqual(minimalPayload);
    expect(result).not.toHaveProperty("injected");
  });

  it("does not add cross-field ordering rules that are not part of the schema", () => {
    const result = CreateSlotBodySchema.safeParse({
      ...minimalPayload,
      startTime: 2_000,
      endTime: 1_000,
    });

    expect(result.success).toBe(true);
  });
});

describe("CreateBookingIntentBodySchema", () => {
  const validSlotId = "slot-12345678-1234-1234-1234-123456789abc";

  it("accepts a single-slot intent and strips unknown fields", () => {
    const result = CreateBookingIntentBodySchema.parse({
      slotId: validSlotId,
      bookingType: "refundable_hold",
      holdDeadlineMs: 1_735_732_800_000,
      extra: "ignored",
    });

    expect(result).toEqual({
      slotId: validSlotId,
      bookingType: "refundable_hold",
      holdDeadlineMs: 1_735_732_800_000,
    });
  });

  it("accepts a recurring intent with an explicit UTC DTSTART", () => {
    const result = CreateBookingIntentBodySchema.safeParse({
      rrule: "DTSTART:20241208T100000Z\nRRULE:FREQ=WEEKLY;COUNT=2",
    });

    expect(result.success).toBe(true);
  });

  it("sanitizes a provided note and accepts the 500-character boundary", () => {
    const result = CreateBookingIntentBodySchema.parse({
      slotId: validSlotId,
      note: "  Please\u0000 confirm  ",
    });
    expect(result.note).toBe("Please confirm");

    expect(
      CreateBookingIntentBodySchema.safeParse({ slotId: validSlotId, note: "x".repeat(500) }).success,
    ).toBe(true);
  });

  it.each([
    ["missing slotId and rrule", {}],
    ["invalid slotId", { slotId: "not-a-slot" }],
    ["empty rrule", { rrule: "   " }],
    ["ambiguous DTSTART", { rrule: "DTSTART:20241208T100000\nRRULE:FREQ=DAILY;COUNT=2" }],
    ["invalid bookingType", { slotId: validSlotId, bookingType: "unknown" }],
    ["non-string note", { slotId: validSlotId, note: 123 }],
    ["empty sanitized note", { slotId: validSlotId, note: "\u0000  " }],
    ["note over 500 characters", { slotId: validSlotId, note: "x".repeat(501) }],
    ["non-number hold deadline", { slotId: validSlotId, holdDeadlineMs: "later" }],
  ])("rejects %s", (_name, payload) => {
    expect(CreateBookingIntentBodySchema.safeParse(payload).success).toBe(false);
  });

  it("accepts a recurring intent with an explicit TZID DTSTART", () => {
    expect(
      CreateBookingIntentBodySchema.safeParse({
        rrule: "DTSTART;TZID=America/New_York:20241208T100000\nRRULE:FREQ=DAILY;COUNT=2",
      }).success,
    ).toBe(true);
  });
});

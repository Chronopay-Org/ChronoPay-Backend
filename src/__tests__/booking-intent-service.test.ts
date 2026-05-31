/// <reference types="jest" />
import {
  parseCreateBookingIntentBody,
  BookingIntentError,
} from "../modules/booking-intents/booking-intent-service.js";

const VALID_SLOT_ID = "slot-11111111-1111-4111-8111-111111111111";

describe("parseCreateBookingIntentBody", () => {
  it("accepts valid booking intent without note", () => {
    const result = parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID });
    expect(result).toEqual({ slotId: VALID_SLOT_ID });
  });

  it("accepts valid booking intent with note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "This is a note",
    });
    expect(result).toEqual({ slotId: VALID_SLOT_ID, note: "This is a note" });
  });

  it("trims slotId", () => {
    const result = parseCreateBookingIntentBody({ slotId: `  ${VALID_SLOT_ID}  ` });
    expect(result.slotId).toBe(VALID_SLOT_ID);
  });

  it("rejects empty slotId", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "   " })).toThrow(
      BookingIntentError,
    );
  });

  it("rejects invalid slotId format", () => {
    expect(() => parseCreateBookingIntentBody({ slotId: "ab" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "a".repeat(65) })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "abc_123" })).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody({ slotId: "abc@123" })).toThrow(
      BookingIntentError,
    );
  });

  it("rejects non-object body", () => {
    expect(() => parseCreateBookingIntentBody(null)).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody(undefined)).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody([])).toThrow(BookingIntentError);
    expect(() => parseCreateBookingIntentBody("string")).toThrow(
      BookingIntentError,
    );
    expect(() => parseCreateBookingIntentBody(123)).toThrow(BookingIntentError);
  });

  it("rejects non-string note", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: 123 }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: null }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: {} }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: [] }),
    ).toThrow(BookingIntentError);
  });

  it("sanitizes note by removing control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x00World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("sanitizes note by removing C1 control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x80World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("preserves tab, newline, and carriage return in note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Line1\nLine2\tTabbed\rReturn",
    });
    expect(result.note).toBe("Line1\nLine2\tTabbed\rReturn");
  });

  it("normalizes unicode in note to NFC", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Cafe\u0301",
    });
    expect(result.note).toBe("Café");
  });

  it("trims whitespace from note", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "  Hello World  ",
    });
    expect(result.note).toBe("Hello World");
  });

  it("rejects empty note after sanitization", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "   " }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\x00\x01\x02" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\t\n\r" }),
    ).toThrow(BookingIntentError);
  });

  it("rejects note exceeding 500 characters after sanitization", () => {
    const longNote = "A".repeat(501);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: longNote }),
    ).toThrow(BookingIntentError);
  });

  it("accepts note exactly 500 characters after sanitization", () => {
    const longNote = "A".repeat(500);
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: longNote,
    });
    expect(result.note).toBe(longNote);
  });

  it("handles note with embedded newlines", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Line1\nLine2\nLine3",
    });
    expect(result.note).toBe("Line1\nLine2\nLine3");
  });

  it("handles note with null bytes", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x00World",
    });
    expect(result.note).toBe("HelloWorld");
  });

  it("handles note with mixed control characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\x00World\x01Test\x02End",
    });
    expect(result.note).toBe("HelloWorldTestEnd");
  });

  it("handles note with unicode characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello 世界 Café",
    });
    expect(result.note).toBe("Hello 世界 Café");
  });

  it("handles note with zero-width characters", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Hello\u200BWorld",
    });
    expect(result.note).toBe("Hello\u200BWorld");
  });

  it("rejects note that becomes empty after stripping control characters", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: VALID_SLOT_ID, note: "\x00\x01\x02" }),
    ).toThrow(BookingIntentError);
  });

  it("handles note with combining marks and checks length after normalization", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "e\u0301",
    });
    expect(result.note).toBe("é");
    expect(result.note?.length).toBe(1);
  });

  it("validates slotId format with alphanumeric and hyphens", () => {
    const result = parseCreateBookingIntentBody({
      slotId: VALID_SLOT_ID,
      note: "Test",
    });
    expect(result.slotId).toBe(VALID_SLOT_ID);
  });

  it("rejects slotId with special characters", () => {
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc@123" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc#123" }),
    ).toThrow(BookingIntentError);
    expect(() =>
      parseCreateBookingIntentBody({ slotId: "abc 123" }),
    ).toThrow(BookingIntentError);
  });
});

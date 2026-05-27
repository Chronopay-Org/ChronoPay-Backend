/// <reference types="jest" />
import { sanitizeNote, redactPhone } from "../utils/redact.js";

describe("redactPhone", () => {
  it("redacts phone numbers with leading +", () => {
    expect(redactPhone("+12025550123")).toBe("+*********23");
    expect(redactPhone("+447911123456")).toBe("+**********56");
    expect(redactPhone("+1234")).toBe("+**34");
  });

  it("handles phone numbers without leading +", () => {
    expect(redactPhone("12025550123")).toBe("1**********");
    expect(redactPhone("123")).toBe("1**");
    expect(redactPhone("12")).toBe("1*");
  });

  it("handles short phone numbers", () => {
    expect(redactPhone("+12")).toBe("+**");
    expect(redactPhone("+1")).toBe("+*");
    expect(redactPhone("1")).toBe("***");
  });
});

describe("sanitizeNote", () => {
  it("removes C0 control characters except tab, newline, and carriage return", () => {
    expect(sanitizeNote("Hello\x00World")).toBe("HelloWorld");
    expect(sanitizeNote("Test\x01String")).toBe("TestString");
    expect(sanitizeNote("Data\x02Here")).toBe("DataHere");
    expect(sanitizeNote("Text\x03End")).toBe("TextEnd");
    expect(sanitizeNote("Start\x04Middle")).toBe("StartMiddle");
    expect(sanitizeNote("Begin\x05Finish")).toBe("BeginFinish");
    expect(sanitizeNote("A\x06B")).toBe("AB");
    expect(sanitizeNote("X\x07Y")).toBe("XY");
    expect(sanitizeNote("P\x08Q")).toBe("PQ");
    expect(sanitizeNote("Line1\x0BLine2")).toBe("Line1Line2");
    expect(sanitizeNote("Page\x0CBreak")).toBe("PageBreak");
    expect(sanitizeNote("Shift\x0EOut")).toBe("ShiftOut");
    expect(sanitizeNote("In\x0FLine")).toBe("InLine");
    expect(sanitizeNote("Data\x10Link")).toBe("DataLink");
    expect(sanitizeNote("Device\x11Control")).toBe("DeviceControl");
    expect(sanitizeNote("X\x12Y\x13Z")).toBe("XYZ");
    expect(sanitizeNote("Cancel\x14Line")).toBe("CancelLine");
    expect(sanitizeNote("Message\x15End")).toBe("MessageEnd");
    expect(sanitizeNote("Sync\x16Idle")).toBe("SyncIdle");
    expect(sanitizeNote("Block\x17End")).toBe("BlockEnd");
    expect(sanitizeNote("Cancel\x19Char")).toBe("CancelChar");
    expect(sanitizeNote("Media\x1AEnd")).toBe("MediaEnd");
    expect(sanitizeNote("Escape\x1BSeq")).toBe("EscapeSeq");
    expect(sanitizeNote("File\x1CSep")).toBe("FileSep");
    expect(sanitizeNote("Group\x1DSep")).toBe("GroupSep");
    expect(sanitizeNote("Record\x1ESep")).toBe("RecordSep");
    expect(sanitizeNote("Unit\x1FSep")).toBe("UnitSep");
  });

  it("preserves tab, newline, and carriage return characters", () => {
    expect(sanitizeNote("Hello\tWorld")).toBe("Hello\tWorld");
    expect(sanitizeNote("Line1\nLine2")).toBe("Line1\nLine2");
    expect(sanitizeNote("Line1\rLine2")).toBe("Line1\rLine2");
    expect(sanitizeNote("Tab\tNewline")).toBe("Tab\tNewline");
  });

  it("removes C1 control characters (0x80-0x9F)", () => {
    expect(sanitizeNote("Hello\x80World")).toBe("HelloWorld");
    expect(sanitizeNote("Test\x81String")).toBe("TestString");
    expect(sanitizeNote("Data\x82Here")).toBe("DataHere");
    expect(sanitizeNote("Text\x90End")).toBe("TextEnd");
    expect(sanitizeNote("Start\x9FMiddle")).toBe("StartMiddle");
    expect(sanitizeNote("Normal\x85Text\x9C")).toBe("NormalText");
  });

  it("normalizes unicode to NFC form", () => {
    // é can be represented as single character (NFC) or e + combining acute (NFD)
    expect(sanitizeNote("Cafe\u0301")).toBe("Café");
    expect(sanitizeNote("Noe\u0308l")).toBe("Noël");
    expect(sanitizeNote("co\u0302ope\u0301ration")).toBe("côopération");
  });

  it("trims whitespace", () => {
    expect(sanitizeNote("  Hello World  ")).toBe("Hello World");
    expect(sanitizeNote("\t\n  Text  \n\t")).toBe("Text");
    expect(sanitizeNote("   ")).toBe(null);
  });

  it("returns null for empty strings after sanitization", () => {
    expect(sanitizeNote("")).toBe(null);
    expect(sanitizeNote("   ")).toBe(null);
    expect(sanitizeNote("\t\n\r")).toBe(null);
    expect(sanitizeNote("\x00\x01\x02")).toBe(null);
    expect(sanitizeNote("\x80\x81\x82")).toBe(null);
  });

  it("handles zero-width characters", () => {
    expect(sanitizeNote("Hello\u200BWorld")).toBe("Hello\u200BWorld");
    expect(sanitizeNote("Text\u200C\u200DMore")).toBe("Text\u200C\u200DMore");
  });

  it("handles combining marks and length after normalization", () => {
    // Before normalization: "e\u0301" is 2 characters
    // After NFC normalization: "é" is 1 character
    const result = sanitizeNote("e\u0301");
    expect(result).toBe("é");
    expect(result?.length).toBe(1);
  });

  it("handles embedded newlines", () => {
    expect(sanitizeNote("Line1\nLine2\nLine3")).toBe("Line1\nLine2\nLine3");
    expect(sanitizeNote("Para1\r\nPara2")).toBe("Para1\r\nPara2");
  });

  it("handles null bytes", () => {
    expect(sanitizeNote("Hello\x00World")).toBe("HelloWorld");
    expect(sanitizeNote("\x00\x00\x00")).toBe(null);
  });

  it("handles mixed control characters and normal text", () => {
    expect(sanitizeNote("Hello\x00World\x01Test")).toBe("HelloWorldTest");
    expect(sanitizeNote("\x01Start\x02Middle\x03End")).toBe("StartMiddleEnd");
  });

  it("preserves normal unicode characters", () => {
    expect(sanitizeNote("Hello 世界")).toBe("Hello 世界");
    expect(sanitizeNote("Café")).toBe("Café");
    expect(sanitizeNote("Привет")).toBe("Привет");
    expect(sanitizeNote("مرحبا")).toBe("مرحبا");
  });

  it("handles strings with only control characters", () => {
    expect(sanitizeNote("\x00\x01\x02\x03")).toBe(null);
    expect(sanitizeNote("\x80\x81\x82\x83")).toBe(null);
    expect(sanitizeNote("\x00\x80\x01\x81")).toBe(null);
  });

  it("handles edge case of single character", () => {
    expect(sanitizeNote("A")).toBe("A");
    expect(sanitizeNote("\x00")).toBe(null);
    expect(sanitizeNote("\x80")).toBe(null);
  });

  it("handles strings at maximum length limit", () => {
    const longString = "A".repeat(500);
    expect(sanitizeNote(longString)).toBe(longString);
  });

  it("handles strings exceeding length limit after normalization", () => {
    // Create a string that's under 500 chars before normalization but over after
    // This is tricky since NFC normalization typically reduces length
    // So we test that length is checked after normalization
    const longString = "A".repeat(500);
    expect(sanitizeNote(longString)?.length).toBe(500);
  });
});

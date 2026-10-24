import {
  buildOtpauthUri,
  base32Decode,
  base32Encode,
  generateTotpCode,
  generateTotpSecret,
  totpCounter,
  verifyTotpCode,
} from "../totp.js";

const RFC4226_TEST_KEY = Buffer.from("12345678901234567890", "ascii");

// RFC 6238 Appendix B.1 test vectors (SHA1). The published values are 8-digit;
// this implementation uses the last 6 digits of the full truncation window.
const RFC6238_VECTORS: Array<{ counter: number; code6: string }> = [
  { counter: 1, code6: "287082" },
  { counter: 37037036, code6: "081804" },
  { counter: 37037037, code6: "050471" },
  { counter: 41152263, code6: "005924" },
  { counter: 66666666, code6: "279037" },
  { counter: 666666666, code6: "353130" },
];

describe("generateTotpCode (RFC 6238 known-answer tests)", () => {
  it.each(RFC6238_VECTORS)("matches vector for counter $counter", ({ counter, code6 }) => {
    expect(generateTotpCode(RFC4226_TEST_KEY, counter)).toBe(code6);
  });

  it("rejects non-integer counters", () => {
    expect(() => generateTotpCode(RFC4226_TEST_KEY, -1)).toThrow(RangeError);
    expect(() => generateTotpCode(RFC4226_TEST_KEY, 1.5)).toThrow(RangeError);
  });

  it("rejects invalid digits/period options", () => {
    expect(() => generateTotpCode(RFC4226_TEST_KEY, 0, { digits: 5 })).toThrow(RangeError);
    expect(() => generateTotpCode(RFC4226_TEST_KEY, 0, { digits: 11 })).toThrow(RangeError);
  });
});

describe("totpCounter", () => {
  it("floors timestamps into 30s periods", () => {
    expect(totpCounter(59 * 1000)).toBe(1);
    expect(totpCounter(30 * 1000)).toBe(1);
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29 * 1000)).toBe(0);
    expect(totpCounter(60 * 1000)).toBe(2);
  });

  it("supports custom periods", () => {
    expect(totpCounter(59 * 1000, 60)).toBe(0);
    expect(totpCounter(60 * 1000, 60)).toBe(1);
  });

  it("rejects invalid periods", () => {
    expect(() => totpCounter(1000, 0)).toThrow(RangeError);
    expect(() => totpCounter(1000, -5)).toThrow(RangeError);
  });
});

describe("generateTotpSecret", () => {
  it("defaults to 20 bytes", () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
  });

  it("honours explicit sizes", () => {
    expect(generateTotpSecret(32)).toHaveLength(32);
  });

  it("(with overwhelming probability) produces different values each call", () => {
    expect(generateTotpSecret().toString("hex")).not.toBe(generateTotpSecret().toString("hex"));
  });

  it("rejects out-of-range sizes", () => {
    expect(() => generateTotpSecret(8)).toThrow(RangeError);
    expect(() => generateTotpSecret(65)).toThrow(RangeError);
  });
});

describe("base32 encoding/decoding (RFC 4648 round trips)", () => {
  it.each([
    Buffer.from("f", "ascii"),
    Buffer.from("fo", "ascii"),
    Buffer.from("foo", "ascii"),
    Buffer.from("foob", "ascii"),
    Buffer.from("fooba", "ascii"),
    Buffer.from("foobar", "ascii"),
    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  ])("round-trips %j", (input) => {
    expect(base32Decode(base32Encode(input)).equals(input)).toBe(true);
  });

  it("tolerates lowercase, spacing, and '=' padding", () => {
    const encoded = base32Encode(Buffer.from("foobar", "ascii"));
    expect(base32Decode(encoded.toLowerCase().replace(/(.{7})/g, "$1 "))).toEqual(
      Buffer.from("foobar", "ascii"),
    );
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("ABC!")).toThrow(/Invalid base32 character/);
  });

  it("rejects empty input", () => {
    expect(() => base32Decode("")).toThrow(/empty/);
  });
});

describe("verifyTotpCode", () => {
  const nowMs = 1_700_000_000_000; // a fixed reference time
  const nowStep = totpCounter(nowMs);

  it("accepts the code for the current step", () => {
    const current = generateTotpCode(RFC4226_TEST_KEY, nowStep);
    expect(verifyTotpCode(RFC4226_TEST_KEY, current, {}, nowMs)).toBe(nowStep);
  });

  it("accepts codes within the skew window (clock drift)", () => {
    const previousStep = generateTotpCode(RFC4226_TEST_KEY, nowStep - 1);
    expect(verifyTotpCode(RFC4226_TEST_KEY, previousStep, { window: 1 }, nowMs)).toBe(nowStep - 1);
    const nextStep = generateTotpCode(RFC4226_TEST_KEY, nowStep + 1);
    expect(verifyTotpCode(RFC4226_TEST_KEY, nextStep, { window: 1 }, nowMs)).toBe(nowStep + 1);
  });

  it("rejects codes beyond the configured window", () => {
    const stale = generateTotpCode(RFC4226_TEST_KEY, nowStep - 2);
    expect(verifyTotpCode(RFC4226_TEST_KEY, stale, { window: 1 }, nowMs)).toBeNull();
  });

  it("rejects wrong, non-numeric, and malformed codes", () => {
    const wrong = String((parseInt(generateTotpCode(RFC4226_TEST_KEY, nowStep), 10) + 1) % 1_000_000).padStart(6, "0");
    expect(verifyTotpCode(RFC4226_TEST_KEY, wrong, {}, nowMs)).toBeNull();
    expect(verifyTotpCode(RFC4226_TEST_KEY, "abcdef", {}, nowMs)).toBeNull();
    expect(verifyTotpCode(RFC4226_TEST_KEY, "", {}, nowMs)).toBeNull();
    expect(verifyTotpCode(RFC4226_TEST_KEY, "123", {}, nowMs)).toBeNull();
    expect(verifyTotpCode(RFC4226_TEST_KEY, "1234567", {}, nowMs)).toBeNull();
  });

  it("trims surrounding whitespace in the code", () => {
    const current = generateTotpCode(RFC4226_TEST_KEY, nowStep);
    expect(verifyTotpCode(RFC4226_TEST_KEY, ` ${current} `, {}, nowMs)).toBe(nowStep);
  });

  it("uses default options/time when omitted", () => {
    const step = totpCounter(Date.now());
    const current = generateTotpCode(RFC4226_TEST_KEY, step);
    expect(verifyTotpCode(RFC4226_TEST_KEY, current)).toBe(step);
  });

  it("rejects invalid windows", () => {
    expect(() => verifyTotpCode(RFC4226_TEST_KEY, "123456", { window: -1 }, nowMs)).toThrow(RangeError);
    expect(() => verifyTotpCode(RFC4226_TEST_KEY, "123456", { window: 11 }, nowMs)).toThrow(RangeError);
    expect(() => verifyTotpCode(RFC4226_TEST_KEY, "123456", { window: 1.5 }, nowMs)).toThrow(RangeError);
  });
});

describe("buildOtpauthUri", () => {
  it("builds a well-formed otpauth URI", () => {
    const uri = buildOtpauthUri("ChronoPay", "user-123", "JBSWY3DPEHPK3PXP");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=ChronoPay");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
  });

  it("encodes label characters for the otpauth label", () => {
    const uri = buildOtpauthUri("Acme Corp", "jane doe@example.com", "AAAA");
    expect(uri).toMatch(/otpauth:\/\/totp\/Acme\+Corp%3Ajane\+doe%40example\.com\?/);
  });

  it("honours custom digits/period", () => {
    const uri = buildOtpauthUri("ChronoPay", "u", "AAAA", { digits: 8, period: 60 });
    expect(uri).toContain("digits=8");
    expect(uri).toContain("period=60");
  });
});
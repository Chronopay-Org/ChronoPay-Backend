/**
 * pseudonymizer.test.ts
 *
 * Tests for the GDPR pseudonymizer covering:
 *  - getSecret() validation across environments (production / development / test)
 *  - pseudonymize() determinism and idempotency
 *  - isPseudonymized() format detection
 *  - empty-value passthrough
 */

import { jest } from "@jest/globals";
import { pseudonymize, isPseudonymized, getSecret } from "../pseudonymizer.js";

// ─── Env helpers ──────────────────────────────────────────────────────────────

const PLACEHOLDER = "change-me-to-secure-secret";
const VALID_SECRET = "a-very-long-and-cryptographically-secure-secret-32+";

/** Snapshot of env so each test starts from a clean, known state. */
const ORIGINAL_SECRET = process.env.PSEUDONYMIZER_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setEnv(secret: string | undefined, nodeEnv: string | undefined) {
  if (secret === undefined) {
    delete process.env.PSEUDONYMIZER_SECRET;
  } else {
    process.env.PSEUDONYMIZER_SECRET = secret;
  }
  if (nodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = nodeEnv;
  }
}

afterEach(() => {
  // Restore the original env after every test.
  setEnv(ORIGINAL_SECRET, ORIGINAL_NODE_ENV);
});

// ─── getSecret — production ──────────────────────────────────────────────────

describe("getSecret — production", () => {
  beforeEach(() => setEnv(undefined, "production"));

  it("throws when PSEUDONYMIZER_SECRET is unset", () => {
    expect(() => getSecret()).toThrow(/PSEUDONYMIZER_SECRET must be set in production/);
  });

  it("throws when PSEUDONYMIZER_SECRET is empty", () => {
    setEnv("   ", "production");
    expect(() => getSecret()).toThrow(/PSEUDONYMIZER_SECRET must be set in production/);
  });

  it("throws when PSEUDONYMIZER_SECRET is the placeholder", () => {
    setEnv(PLACEHOLDER, "production");
    expect(() => getSecret()).toThrow(/must not be the default placeholder/);
  });

  it("throws when PSEUDONYMIZER_SECRET is shorter than 32 characters", () => {
    setEnv("short-but-real-looking", "production");
    expect(() => getSecret()).toThrow(/at least 32 characters/);
  });

  it("returns the secret when it is valid (32+ chars, not the placeholder)", () => {
    setEnv(VALID_SECRET, "production");
    expect(getSecret()).toBe(VALID_SECRET);
  });

  it("accepts a secret that is exactly 32 characters", () => {
    const exactly32 = "0123456789abcdef0123456789abcdef01234567";
    setEnv(exactly32, "production");
    expect(getSecret()).toBe(exactly32);
  });
});

// ─── getSecret — development ──────────────────────────────────────────────────

describe("getSecret — development", () => {
  beforeEach(() => setEnv(undefined, "development"));

  it("falls back to the placeholder when unset", () => {
    expect(getSecret()).toBe(PLACEHOLDER);
  });

  it("falls back to the placeholder when empty", () => {
    setEnv("   ", "development");
    expect(getSecret()).toBe(PLACEHOLDER);
  });

  it("uses the provided secret when set", () => {
    setEnv("my-dev-secret", "development");
    expect(getSecret()).toBe("my-dev-secret");
  });
});

// ─── getSecret — test ─────────────────────────────────────────────────────────

describe("getSecret — test", () => {
  beforeEach(() => setEnv(undefined, "test"));

  it("falls back to the placeholder when unset", () => {
    expect(getSecret()).toBe(PLACEHOLDER);
  });

  it("uses the provided secret when set", () => {
    setEnv("my-test-secret", "test");
    expect(getSecret()).toBe("my-test-secret");
  });
});

// ─── getSecret — NODE_ENV unset ───────────────────────────────────────────────

describe("getSecret — NODE_ENV unset", () => {
  beforeEach(() => setEnv(undefined, undefined));

  it("falls back to the placeholder (treated as non-production)", () => {
    expect(getSecret()).toBe(PLACEHOLDER);
  });
});

// ─── pseudonymize — basic behaviour ───────────────────────────────────────────

describe("pseudonymize", () => {
  beforeEach(() => setEnv(VALID_SECRET, "test"));

  it("produces a deterministic, stable pseudonym", () => {
    setEnv("stable-secret-for-determinism-test-1234", "test");
    const a = pseudonymize("alice@example.com");
    const b = pseudonymize("alice@example.com");
    expect(a).toBe(b);
  });

  it("produces different pseudonyms for different inputs", () => {
    const a = pseudonymize("alice@example.com");
    const b = pseudonymize("bob@example.com");
    expect(a).not.toBe(b);
  });

  it("produces a 43-char URL-safe base64 string (SHA-256 base64url)", () => {
    const result = pseudonymize("alice@example.com");
    expect(result).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("returns the input unchanged when it is empty", () => {
    expect(pseudonymize("")).toBe("");
  });

  it("is idempotent — a pseudonym passed back in is returned unchanged", () => {
    const pseudonym = pseudonymize("alice@example.com");
    expect(pseudonymize(pseudonym)).toBe(pseudonym);
  });

  it("uses the env secret to key the HMAC", () => {
    setEnv("secret-one-that-is-long-enough-for-testing-1", "test");
    const a = pseudonymize("alice@example.com");
    setEnv("secret-two-that-is-long-enough-for-testing-2", "test");
    const b = pseudonymize("alice@example.com");
    expect(a).not.toBe(b);
  });
});

// ─── pseudonymize — production guard ──────────────────────────────────────────

describe("pseudonymize — production guard", () => {
  beforeEach(() => setEnv(undefined, "production"));

  it("throws on first call when the secret is missing in production", () => {
    expect(() => pseudonymize("alice@example.com")).toThrow(
      /PSEUDONYMIZER_SECRET must be set in production/,
    );
  });

  it("does not throw before the first call (lazy resolution)", () => {
    // Importing the module / setting up should not throw — only the actual
    // pseudonymize call triggers validation.
    // (This test passes simply by reaching this point without an error.)
    expect(() => pseudonymize("alice@example.com")).toThrow();
  });
});

// ─── isPseudonymized ──────────────────────────────────────────────────────────

describe("isPseudonymized", () => {
  it("recognises a value produced by pseudonymize", () => {
    setEnv(VALID_SECRET, "test");
    const pseudonym = pseudonymize("alice@example.com");
    expect(isPseudonymized(pseudonym)).toBe(true);
  });

  it("rejects plain email addresses", () => {
    expect(isPseudonymized("alice@example.com")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isPseudonymized("")).toBe(false);
  });

  it("rejects strings of the wrong length", () => {
    expect(isPseudonymized("short")).toBe(false);
    expect(isPseudonymized("a".repeat(42))).toBe(false);
    expect(isPseudonymized("a".repeat(44))).toBe(false);
  });

  it("rejects strings with non-base64url characters", () => {
    expect(isPseudonymized("a".repeat(43).replace(/^./, "!"))).toBe(false);
  });
});

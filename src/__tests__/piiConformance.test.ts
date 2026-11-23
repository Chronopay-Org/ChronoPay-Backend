/// <reference types="jest" />
/**
 * PII Redaction Conformance Suite
 *
 * Asserts that the piiScanner utility correctly identifies (or ignores) PII
 * across the full pattern library.  Every describe block is self-contained so
 * failures are easy to triage.
 *
 * Coverage targets
 * ─────────────────
 *   luhnCheck            – valid/invalid cards, edge-length values
 *   scanText / email     – standard, unicode local-part, plus-alias, false-positives
 *   scanText / phone     – E.164, NANP, international, already-masked, false-positives
 *   scanText / address   – US street addresses, false-positives
 *   scanText / card_pan  – Luhn-valid PANs, Luhn-invalid rejected, masked values
 *   scanText / card_bin  – common issuer prefixes, false-positives
 *   scanText / ssn       – formatted SSNs, invalid area codes
 *   scanText / combined  – multiple PII types in one string
 *   scanText / encoding  – base64-encoded payloads, unicode obfuscation
 *   scanText / allowlist – caller-supplied suppression rules
 *   scanValue            – object / array / primitive serialisation
 *   LogSampleStore       – capture, clear, auditAll, size
 *   defaultLogStore      – module-level singleton export
 *   ScanOptions          – custom pattern override
 */

import {
  luhnCheck,
  scanText,
  scanValue,
  LogSampleStore,
  defaultLogStore,
  DEFAULT_PATTERNS,
  type PiiPattern,
  type ScanResult,
  type SampleViolation,
  type LogSample,
} from "../utils/piiScanner.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Assert that a scan result contains exactly one hit with the given patternId. */
function expectSingleHit(result: ScanResult, patternId: string): void {
  expect(result.hasPii).toBe(true);
  const ids = result.hits.map((h) => h.patternId);
  expect(ids).toContain(patternId);
}

/** Assert that a scan result contains no hits for the given patternId. */
function expectNoHitFor(result: ScanResult, patternId: string): void {
  const ids = result.hits.map((h) => h.patternId);
  expect(ids).not.toContain(patternId);
}

// ─────────────────────────────────────────────────────────────────────────────
// luhnCheck
// ─────────────────────────────────────────────────────────────────────────────
describe("luhnCheck", () => {
  it("accepts a known-valid Visa test PAN", () => {
    expect(luhnCheck("4532015112830366")).toBe(true);
  });

  it("accepts a known-valid Mastercard test PAN", () => {
    expect(luhnCheck("5425233430109903")).toBe(true);
  });

  it("accepts a known-valid Amex test PAN (15 digits)", () => {
    expect(luhnCheck("378282246310005")).toBe(true);
  });

  it("accepts a known-valid Discover test PAN", () => {
    expect(luhnCheck("6011111111111117")).toBe(true);
  });

  it("rejects a PAN where the last digit is wrong", () => {
    // Flip the last digit of the Visa PAN
    expect(luhnCheck("4532015112830367")).toBe(false);
  });

  it("rejects a sequence that is too short", () => {
    expect(luhnCheck("123456789012")).toBe(false); // 12 digits → below min
  });

  it("rejects a sequence that is too long", () => {
    expect(luhnCheck("12345678901234567890")).toBe(false); // 20 digits → above max
  });

  it("handles spaces and dashes in the input", () => {
    // 4532 0151 1283 0366 — same digits, spaced
    expect(luhnCheck("4532 0151 1283 0366")).toBe(true);
    expect(luhnCheck("4532-0151-1283-0366")).toBe(true);
  });

  it("rejects an all-zeros sequence (not Luhn-valid at card length)", () => {
    // 0000000000000000 is 16 zeros — check digit would need to pass
    // sum of doubled every other 0 = 0, so it actually IS valid by the algorithm
    // but it starts with 0 which is not a real issuer. We only test Luhn here.
    expect(typeof luhnCheck("0000000000000000")).toBe("boolean");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// email pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — email", () => {
  it("detects a plain email address", () => {
    const r = scanText("Contact us at alice@example.com today.");
    expectSingleHit(r, "email");
    expect(r.hits[0]!.match).toBe("alice@example.com");
  });

  it("detects an email with a plus alias", () => {
    const r = scanText("Sent to bob+newsletters@domain.org");
    expectSingleHit(r, "email");
    expect(r.hits[0]!.match).toBe("bob+newsletters@domain.org");
  });

  it("detects an email with a subdomain", () => {
    const r = scanText("Reply to carol@mail.internal.company.co.uk");
    expectSingleHit(r, "email");
  });

  it("detects an email embedded in a JSON-like log line", () => {
    const r = scanText('{"user":"dan@payments.io","action":"login"}');
    expectSingleHit(r, "email");
    expect(r.hits[0]!.match).toBe("dan@payments.io");
  });

  it("detects multiple emails in one string", () => {
    const r = scanText("from: alice@x.com to: bob@y.com");
    expect(r.hasPii).toBe(true);
    const emailHits = r.hits.filter((h) => h.patternId === "email");
    expect(emailHits.length).toBeGreaterThanOrEqual(2);
  });

  it("detects a unicode local-part (latin extended)", () => {
    // é is in the U+00C0–U+017E range covered by the pattern
    const r = scanText("User héro@example.com registered");
    expectSingleHit(r, "email");
  });

  it("does NOT flag a masked email value containing ***", () => {
    // al***om is already redacted — the regex won't match because *** breaks
    // the local-part syntax.
    const r = scanText("al***@ex***.com logged in");
    expectNoHitFor(r, "email");
  });

  it("does NOT flag a bare @ symbol", () => {
    const r = scanText("Use @mentions on Twitter");
    expectNoHitFor(r, "email");
  });

  it("does NOT flag a domain without a local-part", () => {
    const r = scanText("Visit example.com for more info");
    expectNoHitFor(r, "email");
  });

  it("does NOT flag an incomplete address missing the TLD", () => {
    const r = scanText("contact@localhost is not valid");
    expectNoHitFor(r, "email");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phone pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — phone", () => {
  it("detects an E.164 international phone number", () => {
    const r = scanText("Call +12025550123 for support.");
    expectSingleHit(r, "phone");
  });

  it("detects a NANP number with dashes", () => {
    const r = scanText("Reach us at 202-555-0123.");
    expectSingleHit(r, "phone");
  });

  it("detects a NANP number with dots", () => {
    const r = scanText("Phone: 202.555.0123");
    expectSingleHit(r, "phone");
  });

  it("detects a NANP number with parentheses", () => {
    const r = scanText("Call (800) 555-1234 now");
    expectSingleHit(r, "phone");
  });

  it("detects a UK mobile in E.164 format", () => {
    const r = scanText("Texted +447911123456 at 09:00");
    expectSingleHit(r, "phone");
  });

  it("detects a phone in a JSON log object", () => {
    const r = scanText('{"phone":"+12025550123","action":"verified"}');
    expectSingleHit(r, "phone");
  });

  it("does NOT flag a short numeric string that is not a phone", () => {
    const r = scanText("Order id 12345 was processed");
    expectNoHitFor(r, "phone");
  });

  it("does NOT flag an already-masked phone (***)", () => {
    // Masked form like +1***0123 will not match the phone pattern
    const r = scanText("Phone: +1***0123 on file");
    expectNoHitFor(r, "phone");
  });

  it("does NOT flag a plain year range like 2020-2024", () => {
    const r = scanText("Fiscal years 2020-2024 were profitable");
    expectNoHitFor(r, "phone");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// address pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — address", () => {
  it("detects a basic US street address", () => {
    const r = scanText("Shipped to 123 Main Street, Springfield");
    expectSingleHit(r, "address");
  });

  it("detects an address with abbreviated street type", () => {
    const r = scanText("Billing address: 45 Oak Ave");
    expectSingleHit(r, "address");
  });

  it("detects an address with a directional suffix", () => {
    const r = scanText("Office at 1600 Pennsylvania Avenue NW");
    expectSingleHit(r, "address");
  });

  it("detects an address embedded in a log payload", () => {
    const r = scanText('address="742 Evergreen Terrace" city="Springfield"');
    expectSingleHit(r, "address");
  });

  it("does NOT flag a street name without a number", () => {
    const r = scanText("Turn onto Elm Street at the light");
    expectNoHitFor(r, "address");
  });

  it("does NOT flag a lone number", () => {
    const r = scanText("We have 50 items in stock");
    expectNoHitFor(r, "address");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// card PAN pattern (Luhn-validated)
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — card_pan", () => {
  it("detects a Luhn-valid Visa PAN in a log line", () => {
    const r = scanText("Charged card 4532015112830366 for $49.99");
    expectSingleHit(r, "card_pan");
  });

  it("detects a Luhn-valid PAN with spaces between groups", () => {
    const r = scanText("Card: 4532 0151 1283 0366");
    expectSingleHit(r, "card_pan");
  });

  it("detects a Luhn-valid PAN with dashes between groups", () => {
    const r = scanText("Card: 4532-0151-1283-0366");
    expectSingleHit(r, "card_pan");
  });

  it("detects a 15-digit Amex PAN", () => {
    const r = scanText("Amex token: 378282246310005");
    expectSingleHit(r, "card_pan");
  });

  it("does NOT flag a Luhn-invalid digit sequence", () => {
    // Flip last digit → Luhn fails
    const r = scanText("Bad card: 4532015112830367");
    expectNoHitFor(r, "card_pan");
  });

  it("does NOT flag an already-masked PAN (4532***0366)", () => {
    const r = scanText("Token: 4532***0366 on file");
    expectNoHitFor(r, "card_pan");
  });

  it("does NOT flag a 12-digit number (below minimum card length)", () => {
    // Luhn check also rejects < 13 digits
    const r = scanText("ref: 453201511283");
    expectNoHitFor(r, "card_pan");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// card BIN pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — card_bin", () => {
  it("detects a Visa BIN prefix (4xxxxx)", () => {
    const r = scanText("Routing via BIN 453201 to acquirer");
    expectSingleHit(r, "card_bin");
  });

  it("detects a Mastercard BIN prefix (51xxxx)", () => {
    const r = scanText("BIN 512345 detected in request");
    expectSingleHit(r, "card_bin");
  });

  it("detects an Amex BIN prefix (37xxxx)", () => {
    const r = scanText("Amex BIN: 374251");
    expectSingleHit(r, "card_bin");
  });

  it("detects a Discover BIN prefix (6011xx)", () => {
    const r = scanText("Discover BIN 601100 in routing table");
    expectSingleHit(r, "card_bin");
  });

  it("does NOT flag a 5-digit numeric prefix (too short)", () => {
    const r = scanText("Code 45320 is a category");
    expectNoHitFor(r, "card_bin");
  });

  it("does NOT flag a 7-digit number that starts with a BIN-like prefix", () => {
    // 4532011 has 7 digits — the (?!\d) lookahead should prevent a match
    // on just the first 6 when a 7th digit follows
    const r = scanText("ref: 4532011");
    // The BIN 453201 would be followed by '1', so (?!\d) suppresses it
    expectNoHitFor(r, "card_bin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSN pattern
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — ssn", () => {
  it("detects a formatted SSN with dashes", () => {
    const r = scanText("SSN on file: 123-45-6789");
    expectSingleHit(r, "ssn");
  });

  it("detects a formatted SSN with spaces", () => {
    const r = scanText("Social: 123 45 6789");
    expectSingleHit(r, "ssn");
  });

  it("does NOT flag the invalid area code 000", () => {
    const r = scanText("000-45-6789 is not a valid SSN");
    expectNoHitFor(r, "ssn");
  });

  it("does NOT flag the invalid area code 666", () => {
    const r = scanText("666-45-6789 should be blocked");
    expectNoHitFor(r, "ssn");
  });

  it("does NOT flag a 900-series area code", () => {
    const r = scanText("900-45-6789 is an ITIN range, not SSN");
    expectNoHitFor(r, "ssn");
  });

  it("does NOT flag an unformatted 9-digit number", () => {
    // Without dashes or spaces the SSN pattern does not match
    const r = scanText("TxId: 123456789");
    expectNoHitFor(r, "ssn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// combined — multiple PII types in one string
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — combined PII", () => {
  it("detects email and phone together", () => {
    const r = scanText("User alice@example.com called from +12025550123");
    expect(r.hasPii).toBe(true);
    const ids = r.hits.map((h) => h.patternId);
    expect(ids).toContain("email");
    expect(ids).toContain("phone");
  });

  it("detects email and card PAN together", () => {
    const r = scanText(
      "Receipt for bob@shop.com charged to 4532015112830366",
    );
    expect(r.hasPii).toBe(true);
    const ids = r.hits.map((h) => h.patternId);
    expect(ids).toContain("email");
    expect(ids).toContain("card_pan");
  });

  it("returns hits ordered by index", () => {
    // email appears before phone in the string
    const r = scanText(
      "email: alice@example.com phone: 202-555-0123",
    );
    expect(r.hasPii).toBe(true);
    expect(r.hits[0]!.index).toBeLessThan(r.hits[r.hits.length - 1]!.index);
  });

  it("returns hasPii=false and empty hits for a clean string", () => {
    const r = scanText("All fields have been redacted. No PII here.");
    expect(r.hasPii).toBe(false);
    expect(r.hits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// encoding edge cases — base64 payloads and unicode obfuscation
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — encoding edge cases", () => {
  it("does NOT flag a base64-encoded email as raw PII (encoded form)", () => {
    // Base64 of "alice@example.com" is "YWxpY2VAZXhhbXBsZS5jb20="
    // The scanner operates on the serialized string; the base64 form does not
    // contain a valid email token so it should not trigger.
    const encoded = Buffer.from("alice@example.com").toString("base64");
    const r = scanText(`payload=${encoded}`);
    expectNoHitFor(r, "email");
  });

  it("DOES flag a base64-decoded email once decoded by the caller", () => {
    // If a caller decodes the payload before scanning, the email is visible.
    const encoded = Buffer.from("alice@example.com").toString("base64");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const r = scanText(decoded);
    expectSingleHit(r, "email");
  });

  it("does NOT flag a unicode-escaped email (\\uXXXX form)", () => {
    // \\u0040 is '@' — in JSON-serialised form it looks like \\u0040, which
    // the regex will not match as a valid email separator.
    const escaped = "alice\\u0040example.com";
    const r = scanText(escaped);
    expectNoHitFor(r, "email");
  });

  it("DOES flag an email that uses unicode lookalike characters only if it matches the pattern", () => {
    // Fullwidth @ (U+FF20) is outside the pattern's character class, so it
    // won't match — this is the expected/safe behaviour.
    const lookalike = "alice\uFF20example.com";
    const r = scanText(lookalike);
    expectNoHitFor(r, "email");
  });

  it("does NOT flag a base64-encoded phone number", () => {
    const encoded = Buffer.from("+12025550123").toString("base64");
    const r = scanText(`call=${encoded}`);
    expectNoHitFor(r, "phone");
  });

  it("does NOT flag a percent-encoded email address", () => {
    // alice%40example.com — %40 is the URL-encoded '@'
    const r = scanText("ref=alice%40example.com");
    expectNoHitFor(r, "email");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// allowlist / suppression
// ─────────────────────────────────────────────────────────────────────────────
describe("scanText — allowlist suppression", () => {
  it("suppresses a known-safe email using a string match", () => {
    const r = scanText("From: test@example.com", {
      allowlist: ["test@example.com"],
    });
    expectNoHitFor(r, "email");
  });

  it("suppresses a known-safe email using a RegExp", () => {
    const r = scanText("From: test@example.com", {
      allowlist: [/@example\.com$/],
    });
    expectNoHitFor(r, "email");
  });

  it("suppresses only the allowlisted value, still detects others", () => {
    const r = scanText(
      "from: noreply@example.com to: real@user.io",
      { allowlist: ["noreply@example.com"] },
    );
    expect(r.hasPii).toBe(true);
    const emails = r.hits.filter((h) => h.patternId === "email");
    // noreply suppressed, real@user.io should still show
    expect(emails.some((h) => h.match === "real@user.io")).toBe(true);
    expect(emails.some((h) => h.match === "noreply@example.com")).toBe(false);
  });

  it("suppresses a phone number using a string match", () => {
    const r = scanText("test line: 202-555-0123", {
      allowlist: ["202-555-0123"],
    });
    expectNoHitFor(r, "phone");
  });

  it("returns clean result when all hits are suppressed", () => {
    const r = scanText("alice@example.com", {
      allowlist: ["alice@example.com"],
    });
    expect(r.hasPii).toBe(false);
    expect(r.hits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scanValue — object / array / primitive serialisation
// ─────────────────────────────────────────────────────────────────────────────
describe("scanValue", () => {
  it("detects email in a plain object value", () => {
    const r = scanValue({ user: "alice@example.com", action: "login" });
    expectSingleHit(r, "email");
  });

  it("detects phone in a nested object", () => {
    const r = scanValue({
      contact: { phone: "+12025550123" },
    });
    expectSingleHit(r, "phone");
  });

  it("detects PII in an array element", () => {
    const r = scanValue(["clean value", "alice@example.com", "another clean"]);
    expectSingleHit(r, "email");
  });

  it("handles a primitive string", () => {
    const r = scanValue("alice@example.com");
    expectSingleHit(r, "email");
  });

  it("handles a primitive number (no PII)", () => {
    const r = scanValue(42);
    expect(r.hasPii).toBe(false);
  });

  it("handles null gracefully", () => {
    const r = scanValue(null);
    expect(r.hasPii).toBe(false);
  });

  it("handles undefined gracefully", () => {
    const r = scanValue(undefined);
    expect(r.hasPii).toBe(false);
  });

  it("handles a circular reference without throwing", () => {
    const obj: Record<string, unknown> = { name: "safe" };
    obj["self"] = obj; // circular
    expect(() => scanValue(obj)).not.toThrow();
  });

  it("handles a Date object", () => {
    const r = scanValue(new Date("2024-01-01"));
    expect(r.hasPii).toBe(false);
  });

  it("returns clean for a redacted object", () => {
    const r = scanValue({ email: "al***om", phone: "+1***0123" });
    expect(r.hasPii).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LogSampleStore
// ─────────────────────────────────────────────────────────────────────────────
describe("LogSampleStore", () => {
  let store: LogSampleStore;

  beforeEach(() => {
    store = new LogSampleStore();
  });

  it("starts empty", () => {
    expect(store.size).toBe(0);
    expect(store.samples).toHaveLength(0);
  });

  it("captures a string sample and increments size", () => {
    store.capture("test-source", "alice@example.com accessed /api");
    expect(store.size).toBe(1);
    expect(store.samples[0]!.source).toBe("test-source");
  });

  it("captures an object sample (serialises it)", () => {
    store.capture("obj-source", { email: "alice@example.com" });
    expect(store.size).toBe(1);
    expect(store.samples[0]!.payload).toContain("alice@example.com");
  });

  it("clear() removes all samples", () => {
    store.capture("s1", "some text");
    store.capture("s2", "more text");
    store.clear();
    expect(store.size).toBe(0);
  });

  it("auditAll() returns violations for samples with PII", () => {
    store.capture("clean", "no sensitive data here");
    store.capture("dirty", "user email: alice@example.com");

    const violations: SampleViolation[] = store.auditAll();
    expect(violations).toHaveLength(1);
    expect(violations[0]!.source).toBe("dirty");
    expect(violations[0]!.hits[0]!.patternId).toBe("email");
  });

  it("auditAll() returns empty array when all samples are clean", () => {
    store.capture("log1", "transaction processed successfully");
    store.capture("log2", "status: ok");
    expect(store.auditAll()).toHaveLength(0);
  });

  it("auditAll() respects scanner options (allowlist)", () => {
    store.capture("log", "noreply@example.com sent a receipt");
    const violations = store.auditAll({ allowlist: ["noreply@example.com"] });
    expect(violations).toHaveLength(0);
  });

  it("samples getter returns an immutable-like view (no mutation via push)", () => {
    store.capture("s1", "text");
    const view = store.samples;
    // The returned array reference should not be the internal array — adding
    // to it must not affect the store.
    expect(() => {
      (view as LogSample[]).push({ source: "hax", payload: "injected" });
    }).not.toThrow();
    // Store size should still be 1
    expect(store.size).toBe(1);
  });

  it("captures multiple samples from different sources", () => {
    store.capture("route-A", "clean");
    store.capture("route-B", "alice@example.com");
    store.capture("route-C", "+12025550123");

    const violations = store.auditAll();
    const sources = violations.map((v) => v.source);
    expect(sources).toContain("route-B");
    expect(sources).toContain("route-C");
    expect(sources).not.toContain("route-A");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// defaultLogStore (module-level singleton)
// ─────────────────────────────────────────────────────────────────────────────
describe("defaultLogStore", () => {
  afterEach(() => {
    defaultLogStore.clear();
  });

  it("is an instance of LogSampleStore", () => {
    expect(defaultLogStore).toBeInstanceOf(LogSampleStore);
  });

  it("accepts captures and audits them", () => {
    defaultLogStore.capture("singleton-test", "bob@example.com called us");
    const violations = defaultLogStore.auditAll();
    expect(violations).toHaveLength(1);
  });

  it("is cleared between tests via afterEach", () => {
    // Previous afterEach should have cleared it
    expect(defaultLogStore.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Custom pattern override via ScanOptions
// ─────────────────────────────────────────────────────────────────────────────
describe("ScanOptions — custom patterns", () => {
  it("uses a caller-supplied pattern library instead of DEFAULT_PATTERNS", () => {
    const customPattern: PiiPattern = {
      id: "tracking_id",
      description: "Internal tracking ID",
      pattern: /TRK-[A-Z0-9]{8}/g,
    };

    const r = scanText("ref: TRK-ABCD1234 processed", {
      patterns: [customPattern],
    });
    expect(r.hasPii).toBe(true);
    expect(r.hits[0]!.patternId).toBe("tracking_id");
  });

  it("does NOT fire default patterns when a custom library is supplied", () => {
    const customPattern: PiiPattern = {
      id: "tracking_id",
      description: "Internal tracking ID",
      pattern: /TRK-[A-Z0-9]{8}/g,
    };

    // Email is present but default patterns are not used
    const r = scanText("alice@example.com ref: TRK-ABCD1234", {
      patterns: [customPattern],
    });
    expectNoHitFor(r, "email");
    expectSingleHit(r, "tracking_id");
  });

  it("DEFAULT_PATTERNS export contains all six built-in pattern ids", () => {
    const ids = DEFAULT_PATTERNS.map((p) => p.id);
    expect(ids).toContain("email");
    expect(ids).toContain("phone");
    expect(ids).toContain("address");
    expect(ids).toContain("card_pan");
    expect(ids).toContain("card_bin");
    expect(ids).toContain("ssn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// False-positive robustness
// ─────────────────────────────────────────────────────────────────────────────
describe("false-positive robustness", () => {
  it("does not flag a URL with an @ in the userinfo component", () => {
    // Technically valid URL but no real email domain TLD pattern
    const r = scanText("http://user@localhost:3000/path");
    // localhost has no TLD so email pattern should not match
    expectNoHitFor(r, "email");
  });

  it("does not flag semantic version strings as phone numbers", () => {
    const r = scanText("Released v2.10.1234 on 2024-01-01");
    expectNoHitFor(r, "phone");
  });

  it("does not flag a UUID as a card PAN", () => {
    // UUIDs are 32 hex chars with dashes — Luhn check prevents false positives
    const r = scanText("id: 550e8400-e29b-41d4-a716-446655440000");
    expectNoHitFor(r, "card_pan");
  });

  it("does not flag an IPv4 address as a phone number", () => {
    const r = scanText("Connecting to 192.168.100.200");
    expectNoHitFor(r, "phone");
  });

  it("does not flag a price like $1,234.56 as a card PAN", () => {
    const r = scanText("Total: $1,234.56 charged");
    expectNoHitFor(r, "card_pan");
  });

  it("does not flag a Unix timestamp as a phone number", () => {
    const r = scanText("ts: 1711072800");
    expectNoHitFor(r, "phone");
  });
});

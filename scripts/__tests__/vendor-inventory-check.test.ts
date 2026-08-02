/**
 * Tests for scripts/vendor-inventory-check.ts (issue #521).
 *
 * Covers:
 *  - the YAML subset parser (maps, sequences, scalars, comments)
 *  - schema validation (missing risk score, duplicate vendors, bad currency)
 *  - the 12-month freshness rule (stale vs. warning vs. fresh)
 *  - currency-change re-review detection
 *  - end-to-end runCheck behaviour and summary output
 */

import { describe, it, expect } from "@jest/globals";
import {
  buildSummary,
  checkFreshness,
  detectCurrencyChanges,
  parseRegistry,
  parseYaml,
  runCheck,
  validateRegistry,
  VendorRegistry,
} from "../vendor-inventory-check";

const NOW = new Date("2026-08-02T00:00:00Z");

function baseRegistry(overrides: Partial<VendorRegistry> = {}): VendorRegistry {
  return {
    schemaVersion: 1,
    lastUpdated: "2026-07-28",
    allowedCurrencies: ["USD", "EUR"],
    vendors: [
      {
        id: "stripe",
        name: "Stripe",
        category: "payment_processing",
        service: "card payments",
        owner: "payments-team",
        riskScore: 4,
        criticality: "critical",
        currency: "USD",
        reviewDate: "2026-07-01",
        reviewCadenceMonths: 12,
      },
      {
        id: "twilio-sendgrid",
        name: "Twilio SendGrid",
        category: "email_services",
        service: "transactional email",
        owner: "notifications-team",
        riskScore: 2,
        criticality: "medium",
        currency: "USD",
        reviewDate: "2026-05-22",
      },
    ],
    ...overrides,
  };
}

const VALID_YAML = `
# SOC2 vendor inventory
schema_version: 1
last_updated: 2026-07-28
allowed_currencies:
  - USD
  - EUR
vendors:
  - id: stripe
    name: Stripe
    category: payment_processing
    service: card payments
    owner: payments-team
    risk_score: 4
    criticality: critical
    currency: USD
    review_date: 2026-07-01
  - id: twilio-sendgrid
    name: Twilio SendGrid
    category: email_services
    service: transactional email
    owner: notifications-team
    risk_score: 2
    criticality: medium
    currency: USD
    review_date: 2026-05-22
`;

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

describe("parseYaml", () => {
  it("parses maps, sequences, nested blocks and scalars", () => {
    const value = parseYaml(`
schema_version: 1
allowed_currencies:
  - USD
  - EUR
vendors:
  - id: stripe
    name: Stripe
    risk_score: 4
    active: true
`);
    expect(value).toEqual({
      schema_version: 1,
      allowed_currencies: ["USD", "EUR"],
      vendors: [{ id: "stripe", name: "Stripe", risk_score: 4, active: true }],
    });
  });

  it("ignores comments and blank lines", () => {
    const value = parseYaml("# top comment\n\nkey: value # trailing comment\nlist:\n  - a\n");
    expect(value).toEqual({ key: "value", list: ["a"] });
  });

  it("handles quoted scalars", () => {
    const value = parseYaml("title: \"hello: world\"\nliteral: 'a#b'\n");
    expect(value).toEqual({ title: "hello: world", literal: "a#b" });
  });

  it("throws on malformed input", () => {
    expect(() => parseYaml("just some text\n")).toThrow(/expected "key: value"/);
    expect(() => parseYaml("key:\n  nested: 1\nother: 2\n")).not.toThrow();
    expect(() => parseYaml("key:\n  nested: 1\n  - item\n")).toThrow(
      /unexpected|indentation|trailing/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseRegistry
// ---------------------------------------------------------------------------

describe("parseRegistry", () => {
  it("parses a valid registry", () => {
    const registry = parseRegistry(parseYaml(VALID_YAML));
    expect(registry.schemaVersion).toBe(1);
    expect(registry.allowedCurrencies).toEqual(["USD", "EUR"]);
    expect(registry.vendors).toHaveLength(2);
    expect(registry.vendors[0].id).toBe("stripe");
  });

  it("rejects an unsupported schema version", () => {
    const root = parseYaml(VALID_YAML) as Record<string, unknown>;
    root.schema_version = 2;
    expect(() => parseRegistry(root)).toThrow(/unsupported schema_version/);
  });

  it("rejects a missing risk_score", () => {
    const root = parseYaml(VALID_YAML.replace("    risk_score: 4\n", "")) as Record<
      string,
      unknown
    >;
    expect(() => parseRegistry(root)).toThrow(/risk_score/);
  });
});

// ---------------------------------------------------------------------------
// validateRegistry
// ---------------------------------------------------------------------------

describe("validateRegistry", () => {
  it("accepts a valid registry", () => {
    expect(validateRegistry(baseRegistry(), NOW)).toEqual([]);
  });

  it("flags a duplicate vendor entry", () => {
    const reg = baseRegistry();
    reg.vendors.push({ ...reg.vendors[0] });
    expect(validateRegistry(reg, NOW)).toContain("[stripe] duplicate vendor entry");
  });

  it("flags a risk score outside 1..5", () => {
    const reg = baseRegistry();
    reg.vendors[0].riskScore = 6;
    expect(validateRegistry(reg, NOW)).toContain(
      "[stripe] risk_score must be an integer between 1 and 5",
    );
  });

  it("flags an invalid criticality", () => {
    const reg = baseRegistry();
    reg.vendors[0].criticality = "extreme";
    expect(validateRegistry(reg, NOW)).toContain(
      "[stripe] criticality must be one of low, medium, high, critical",
    );
  });

  it("flags a currency not in allowed_currencies", () => {
    const reg = baseRegistry();
    reg.vendors[0].currency = "BTC";
    expect(validateRegistry(reg, NOW)).toContain(
      '[stripe] currency "BTC" is not in allowed_currencies',
    );
  });

  it("flags a malformed or future review_date", () => {
    const reg = baseRegistry();
    reg.vendors[0].reviewDate = "2026-13-45";
    expect(validateRegistry(reg, NOW)).toContain(
      "[stripe] review_date must be a valid YYYY-MM-DD date",
    );

    const reg2 = baseRegistry();
    reg2.vendors[0].reviewDate = "2027-01-01";
    expect(validateRegistry(reg2, NOW)).toContain("[stripe] review_date cannot be in the future");
  });
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

describe("checkFreshness", () => {
  it("passes fresh entries", () => {
    const result = checkFreshness(baseRegistry(), NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails entries older than 12 months", () => {
    const reg = baseRegistry();
    reg.vendors[0].reviewDate = "2025-06-01";
    const result = checkFreshness(reg, NOW);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("older than the 12-month limit");
  });

  it("warns when an entry approaches the limit", () => {
    const reg = baseRegistry();
    reg.vendors[0].reviewDate = "2025-10-02";
    const result = checkFreshness(reg, NOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("review due within");
  });

  it("honours a tighter review_cadence_months", () => {
    const reg = baseRegistry();
    reg.vendors[0].reviewDate = "2026-03-01";
    reg.vendors[0].reviewCadenceMonths = 4;
    const result = checkFreshness(reg, NOW);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("4-month limit");
  });
});

// ---------------------------------------------------------------------------
// Currency changes
// ---------------------------------------------------------------------------

describe("detectCurrencyChanges", () => {
  it("rejects a currency change without a fresh review", () => {
    const prev = baseRegistry();
    const next = baseRegistry();
    next.vendors[0].currency = "EUR";
    const errors = detectCurrencyChanges(prev, next);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("currency changed (USD -> EUR)");
    expect(errors[0]).toContain("review_date was not updated");
  });

  it("accepts a currency change that was re-reviewed", () => {
    const prev = baseRegistry();
    const next = baseRegistry();
    next.vendors[0].currency = "EUR";
    next.vendors[0].reviewDate = "2026-07-29";
    expect(detectCurrencyChanges(prev, next)).toEqual([]);
  });

  it("ignores unrelated changes", () => {
    const prev = baseRegistry();
    const next = baseRegistry();
    next.vendors[1].riskScore = 3;
    expect(detectCurrencyChanges(prev, next)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runCheck + summary
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  it("passes a valid registry", () => {
    const report = runCheck(VALID_YAML, null, NOW);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("fails a stale registry", () => {
    const stale = VALID_YAML.replace("review_date: 2026-07-01", "review_date: 2025-05-01");
    const report = runCheck(stale, null, NOW);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("older than the 12-month limit"))).toBe(true);
  });

  it("fails a duplicate vendor", () => {
    const dup = `${VALID_YAML}\n  - id: stripe\n    name: Stripe 2\n    category: payments\n    service: backup\n    owner: payments-team\n    risk_score: 3\n    criticality: medium\n    currency: USD\n    review_date: 2026-07-01\n`;
    const report = runCheck(dup, null, NOW);
    expect(report.ok).toBe(false);
    expect(report.errors).toContain("[stripe] duplicate vendor entry");
  });

  it("fails unparsable YAML", () => {
    const report = runCheck("not: [valid\n", null, NOW);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/could not be parsed/);
  });

  it("fails on a currency change against the base registry", () => {
    const next = VALID_YAML.replace(
      "currency: USD\n    review_date: 2026-07-01",
      "currency: EUR\n    review_date: 2026-07-01",
    );
    const report = runCheck(next, VALID_YAML, NOW);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes("currency changed"))).toBe(true);
  });
});

describe("buildSummary", () => {
  it("reports vendor count and next review dates", () => {
    const summary = buildSummary(baseRegistry(), [], [], NOW);
    expect(summary).toContain("## SOC2 Vendor Inventory Summary");
    expect(summary).toContain("Vendors: 2");
    expect(summary).toContain("all entries are within the 12-month review limit");
    expect(summary).toContain("`stripe`");
  });

  it("lists errors when present", () => {
    const summary = buildSummary(baseRegistry(), ["[stripe] broken"], [], NOW);
    expect(summary).toContain("[ERROR] [stripe] broken");
  });
});

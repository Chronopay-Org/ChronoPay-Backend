/**
 * checkout-validation.test.ts
 *
 * Focused regression suite for the pure validator functions exported by
 * src/middleware/checkout-validation.ts, plus HTTP-level integration coverage
 * for the two Express middleware factories.
 *
 * Exports under test
 * ──────────────────
 *   isValidEmail                   – RFC-style email format, length ≤ 254
 *   isValidAmount                  – delegates to AmountUtils.validate (positive integer, ≤ 1e14)
 *   isValidAsset                   – Stellar asset: 'native' or '<Code>:<GIssuer>'
 *   isValidCurrency                – USD | EUR | GBP | XLM
 *   isValidPaymentMethod           – credit_card | bank_transfer | crypto
 *   isValidCustomerId              – alphanumeric + _ - , length 1–255
 *   validateCreateCheckoutSession  – Express middleware factory (full body validation)
 *   validateSessionIdParam         – Express middleware factory (UUID param validation)
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  isValidEmail,
  isValidAmount,
  isValidAsset,
  isValidCurrency,
  isValidPaymentMethod,
  isValidCustomerId,
  validateCreateCheckoutSession,
  validateSessionIdParam,
} from "../checkout-validation.js";
import { MAX_MINOR_AMOUNT } from "../../utils/amount.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A valid Stellar public key: G followed by exactly 55 uppercase base-32 chars
 * (alphabet A-Z plus digits 2-7).  Total length = 56.
 *
 * The issuerRegex in the source is /^G[A-Z2-7]{55}$/, so we build one that
 * satisfies it deterministically rather than using a real-world address that
 * might contain characters outside the alphabet (e.g. digits 0, 1, 8, 9).
 */
const VALID_ISSUER = "G" + "A".repeat(55); // 56 chars, all valid base-32

/** Canonical valid asset string used across multiple tests. */
const VALID_ASSET = `USDC:${VALID_ISSUER}`;

/** Minimal valid request body that passes every middleware check. */
function validBody() {
  return {
    payment: {
      amount: 1000,
      currency: "USD",
      paymentMethod: "credit_card",
    },
    customer: {
      customerId: "cust-abc123",
      email: "user@example.com",
    },
  };
}

/** Mount middleware on a POST /checkout route; 200 means next() was called. */
function makeApp(middleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/checkout", middleware, (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

/** Mount session-id param middleware on GET /sessions/:sessionId. */
function makeParamApp(middleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.get("/sessions/:sessionId", middleware, (_req, res) =>
    res.status(200).json({ ok: true }),
  );
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// isValidEmail
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidEmail", () => {
  describe("valid emails → true", () => {
    it.each([
      "user@example.com",
      "user+tag@example.com",
      "user.name@sub.example.co.uk",
      "USER@EXAMPLE.COM",
      "u@e.io",
      "first.last@domain.org",
      "test123@test456.net",
      "x@x.xx",
    ])("accepts %s", (email) => {
      expect(isValidEmail(email)).toBe(true);
    });
  });

  describe("invalid emails → false", () => {
    it.each([
      ["missing @",          "userexample.com"],
      ["missing domain",     "user@"],
      ["missing local part", "@example.com"],
      ["double @",           "user@@example.com"],
      ["space in local",     "user name@example.com"],
      ["space in domain",    "user@exam ple.com"],
      ["no TLD dot",         "user@example"],
      ["empty string",       ""],
    ])("%s: %s", (_label, email) => {
      expect(isValidEmail(email)).toBe(false);
    });
  });

  describe("length boundary", () => {
    // Build an email of exactly 254 chars: a@<248-char host>.com
    const host254 = "d".repeat(248);
    const email254 = `a@${host254}.com`; // 1+1+248+1+3 = 254

    it("email254 has correct length", () => {
      expect(email254.length).toBe(254);
    });

    it("accepts exactly 254 characters", () => {
      expect(isValidEmail(email254)).toBe(true);
    });

    it("rejects 255 characters (one over limit)", () => {
      // Pad host by 1 → a@<249-char host>.com = 255 chars total
      const host255 = "d".repeat(249);
      const e255 = `a@${host255}.com`;
      expect(e255.length).toBe(255);
      expect(isValidEmail(e255)).toBe(false);
    });

    it("rejects very long email strings", () => {
      const longEmail = `${"a".repeat(200)}@${"b".repeat(100)}.com`;
      expect(longEmail.length).toBeGreaterThan(254);
      expect(isValidEmail(longEmail)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidAmount
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidAmount", () => {
  describe("valid amounts → true", () => {
    it.each([1, 100, 1000, 9999, MAX_MINOR_AMOUNT])("accepts %d", (amount) => {
      expect(isValidAmount(amount)).toBe(true);
    });
  });

  describe("invalid numeric amounts → false", () => {
    it.each([
      ["zero",                       0],
      ["negative integer",           -1],
      ["negative large",             -1000],
      ["float",                      1.5],
      ["float near integer",         0.9999],
      ["exceeds MAX_MINOR_AMOUNT",   MAX_MINOR_AMOUNT + 1],
      ["Infinity",                   Infinity],
      ["negative Infinity",          -Infinity],
      ["NaN",                        NaN],
    ] as Array<[string, unknown]>)("%s", (_label, amount) => {
      expect(isValidAmount(amount)).toBe(false);
    });
  });

  describe("wrong types → false", () => {
    it.each([
      ["string numeric",  "1000"],
      ["string float",    "9.99"],
      ["null",            null],
      ["undefined",       undefined],
      ["boolean true",    true],
      ["boolean false",   false],
      ["object",          { value: 100 }],
      ["array",           [100]],
    ] as Array<[string, unknown]>)("%s", (_label, amount) => {
      expect(isValidAmount(amount)).toBe(false);
    });
  });

  describe("boundary values", () => {
    it("accepts 1 (minimum positive integer)", () => {
      expect(isValidAmount(1)).toBe(true);
    });

    it("accepts MAX_MINOR_AMOUNT exactly (1e14)", () => {
      expect(isValidAmount(MAX_MINOR_AMOUNT)).toBe(true);
    });

    it("rejects MAX_MINOR_AMOUNT + 1", () => {
      expect(isValidAmount(MAX_MINOR_AMOUNT + 1)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidAsset
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidAsset", () => {
  describe("valid assets → true", () => {
    it("accepts 'native'", () => {
      expect(isValidAsset("native")).toBe(true);
    });

    it("accepts well-formed USDC asset string", () => {
      expect(isValidAsset(VALID_ASSET)).toBe(true);
    });

    it.each([
      ["1-char code",          `A:${VALID_ISSUER}`],
      ["12-char code (max)",   `ABCDEFGHIJKL:${VALID_ISSUER}`],
      ["mixed-case code",      `uSdC:${VALID_ISSUER}`],
      ["all-numeric code",     `1234:${VALID_ISSUER}`],
      ["alphanumeric code",    `USD1:${VALID_ISSUER}`],
    ])("accepts %s", (_label, asset) => {
      expect(isValidAsset(asset)).toBe(true);
    });
  });

  describe("invalid asset strings → false", () => {
    it.each([
      ["empty string",                    ""],
      ["no colon separator",              `USDC${VALID_ISSUER}`],
      ["two colons (extra segment)",      `USDC:${VALID_ISSUER}:extra`],
      ["code too long (13 chars)",        `ABCDEFGHIJKLM:${VALID_ISSUER}`],
      ["code is empty",                   `:${VALID_ISSUER}`],
      ["code with hyphen",                `USD-C:${VALID_ISSUER}`],
      ["code with space",                 `USD C:${VALID_ISSUER}`],
      // Issuer length errors (regex: G + exactly 55 chars = 56 total)
      ["issuer too short (G + 54 chars)", `USDC:G${"A".repeat(54)}`],
      ["issuer too long  (G + 56 chars)", `USDC:G${"A".repeat(56)}`],
      // Issuer must start with G
      ["issuer wrong leading char",       `USDC:A${"A".repeat(55)}`],
      // Characters outside base-32 alphabet (A-Z, 2-7)
      ["issuer contains '1'",             `USDC:G${"A".repeat(54)}1`],
      ["issuer contains '0'",             `USDC:G${"A".repeat(54)}0`],
      ["issuer contains '8'",             `USDC:G${"A".repeat(54)}8`],
      ["issuer contains lowercase",       `USDC:G${"a".repeat(55)}`],
      // 'native' is case-sensitive
      ["'NATIVE' uppercase",              "NATIVE"],
      ["'Native' mixed case",             "Native"],
    ])("%s", (_label, asset) => {
      expect(isValidAsset(asset)).toBe(false);
    });
  });

  describe("wrong types → false", () => {
    it.each([
      ["number",    12345],
      ["null",      null],
      ["undefined", undefined],
      ["boolean",   true],
      ["object",    { code: "USDC", issuer: VALID_ISSUER }],
      ["array",     ["USDC", VALID_ISSUER]],
    ] as Array<[string, unknown]>)("%s", (_label, asset) => {
      expect(isValidAsset(asset)).toBe(false);
    });
  });

  describe("issuer character-set boundary (base-32: A-Z and 2-7 only)", () => {
    it("accepts issuer whose suffix uses all valid base-32 chars", () => {
      // Cycle through every char in the Stellar base-32 alphabet
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // 32 chars
      const suffix = Array.from({ length: 55 }, (_, i) => alphabet[i % alphabet.length]).join("");
      expect(isValidAsset(`USDC:G${suffix}`)).toBe(true);
    });

    it("accepts issuer ending in '2' (lowest digit in alphabet)", () => {
      expect(isValidAsset(`USDC:G${"A".repeat(54)}2`)).toBe(true);
    });

    it("accepts issuer ending in '7' (highest digit in alphabet)", () => {
      expect(isValidAsset(`USDC:G${"A".repeat(54)}7`)).toBe(true);
    });

    it("rejects issuer ending in '1' (not in base-32 alphabet)", () => {
      expect(isValidAsset(`USDC:G${"A".repeat(54)}1`)).toBe(false);
    });

    it("rejects issuer ending in '8' (not in base-32 alphabet)", () => {
      expect(isValidAsset(`USDC:G${"A".repeat(54)}8`)).toBe(false);
    });

    it("rejects issuer ending in '9' (not in base-32 alphabet)", () => {
      expect(isValidAsset(`USDC:G${"A".repeat(54)}9`)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidCurrency
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidCurrency", () => {
  describe("valid currencies → true", () => {
    it.each(["USD", "EUR", "GBP", "XLM"])("accepts %s", (currency) => {
      expect(isValidCurrency(currency)).toBe(true);
    });
  });

  describe("invalid currencies → false", () => {
    it.each([
      ["lowercase usd",  "usd"],
      ["lowercase eur",  "eur"],
      ["unknown code",   "JPY"],
      ["empty string",   ""],
      ["null",           null],
      ["undefined",      undefined],
      ["number",         840],
      ["object",         { code: "USD" }],
    ] as Array<[string, unknown]>)("%s", (_label, currency) => {
      expect(isValidCurrency(currency)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidPaymentMethod
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidPaymentMethod", () => {
  describe("valid methods → true", () => {
    it.each(["credit_card", "bank_transfer", "crypto"])("accepts %s", (method) => {
      expect(isValidPaymentMethod(method)).toBe(true);
    });
  });

  describe("invalid methods → false", () => {
    it.each([
      ["unknown method",  "debit_card"],
      ["uppercase",       "CREDIT_CARD"],
      ["partial match",   "credit"],
      ["empty string",    ""],
      ["null",            null],
      ["undefined",       undefined],
      ["number",          1],
      ["object",          {}],
    ] as Array<[string, unknown]>)("%s", (_label, method) => {
      expect(isValidPaymentMethod(method)).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidCustomerId
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidCustomerId", () => {
  describe("valid IDs → true", () => {
    it.each([
      "abc",
      "ABC123",
      "cust-abc123",
      "cust_456",
      "a",
      "123",
      "00000000-0000-4000-8000-000000000000",
      "a".repeat(255), // maximum length
    ])("accepts '%s'", (id) => {
      expect(isValidCustomerId(id)).toBe(true);
    });
  });

  describe("invalid IDs → false", () => {
    it.each([
      ["empty string",        ""],
      ["space in ID",         "cust abc"],
      ["special char !",      "cust!123"],
      ["special char @",      "cust@123"],
      ["dot",                 "cust.123"],
      ["too long (256 chars)", "a".repeat(256)],
    ] as Array<[string, unknown]>)("%s", (_label, id) => {
      expect(isValidCustomerId(id)).toBe(false);
    });
  });

  describe("wrong types → false", () => {
    it.each([
      ["number",    12345],
      ["null",      null],
      ["undefined", undefined],
      ["boolean",   true],
      ["object",    { id: "abc" }],
      ["array",     ["abc"]],
    ] as Array<[string, unknown]>)("%s", (_label, id) => {
      expect(isValidCustomerId(id)).toBe(false);
    });
  });

  describe("length boundary", () => {
    it("accepts exactly 255 characters (maximum)", () => {
      expect(isValidCustomerId("a".repeat(255))).toBe(true);
    });

    it("rejects exactly 256 characters (one over maximum)", () => {
      expect(isValidCustomerId("a".repeat(256))).toBe(false);
    });

    it("accepts exactly 1 character (minimum)", () => {
      expect(isValidCustomerId("a")).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateCreateCheckoutSession – middleware integration
// ─────────────────────────────────────────────────────────────────────────────

describe("validateCreateCheckoutSession middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = makeApp(validateCreateCheckoutSession());
  });

  // ── success paths ──────────────────────────────────────────────────────────

  describe("success path", () => {
    it("passes with a fully valid body and calls next()", async () => {
      const res = await request(app).post("/checkout").send(validBody());
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("passes with crypto payment method and valid asset", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "crypto", asset: VALID_ASSET },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(200);
    });

    it("passes with 'native' asset", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "crypto", asset: "native" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(200);
    });

    it("passes with optional metadata object", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), metadata: { orderId: "ord-1", flag: true, count: 3 } });
      expect(res.status).toBe(200);
    });

    it("passes with minimum amount (1)", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: 1 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(200);
    });

    it("passes with all three non-crypto payment methods", async () => {
      for (const method of ["credit_card", "bank_transfer"]) {
        const body = { ...validBody(), payment: { ...validBody().payment, paymentMethod: method } };
        const res = await request(app).post("/checkout").send(body);
        expect(res.status).toBe(200);
      }
    });

    it("passes with every supported currency", async () => {
      for (const currency of ["USD", "EUR", "GBP", "XLM"]) {
        const body = { ...validBody(), payment: { ...validBody().payment, currency } };
        const res = await request(app).post("/checkout").send(body);
        expect(res.status).toBe(200);
      }
    });
  });

  // ── payment object ─────────────────────────────────────────────────────────

  describe("payment object validation", () => {
    it("rejects when payment is absent", async () => {
      const { customer } = validBody();
      const res = await request(app).post("/checkout").send({ customer });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects when payment is a string", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), payment: "bad" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects when payment is null", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), payment: null });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });
  });

  // ── amount ─────────────────────────────────────────────────────────────────

  describe("amount validation", () => {
    it("rejects amount = 0", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: 0 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("rejects negative amount", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: -100 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("rejects float amount", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: 9.99 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("rejects string amount", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: "1000" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("rejects amount exceeding MAX_MINOR_AMOUNT", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, amount: MAX_MINOR_AMOUNT + 1 },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("error details includes field path 'payment.amount'", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: 0 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.details?.field).toBe("payment.amount");
    });
  });

  // ── asset ──────────────────────────────────────────────────────────────────

  describe("asset validation", () => {
    it("rejects invalid asset when paymentMethod is 'crypto'", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "crypto", asset: "INVALID" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_ASSET");
    });

    it("rejects malformed asset when asset key is present (any payment method)", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, asset: "BAD_ASSET_NO_COLON" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_ASSET");
    });

    it("skips asset check when method is not 'crypto' and no asset key provided", async () => {
      const res = await request(app).post("/checkout").send(validBody()); // credit_card, no asset
      expect(res.status).toBe(200);
    });

    it("error details includes field path 'payment.asset'", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "crypto", asset: "BAD" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.details?.field).toBe("payment.asset");
    });
  });

  // ── currency ───────────────────────────────────────────────────────────────

  describe("currency validation", () => {
    it("rejects unsupported currency code", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, currency: "JPY" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CURRENCY");
    });

    it("rejects lowercase currency", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, currency: "usd" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CURRENCY");
    });
  });

  // ── paymentMethod ──────────────────────────────────────────────────────────

  describe("paymentMethod validation", () => {
    it("rejects unknown payment method", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "paypal" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PAYMENT_METHOD");
    });

    it("rejects uppercase variant of valid method", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "CREDIT_CARD" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PAYMENT_METHOD");
    });

    it("accepts 'crypto' with a valid asset", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, paymentMethod: "crypto", asset: VALID_ASSET },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(200);
    });
  });

  // ── customer object ────────────────────────────────────────────────────────

  describe("customer object validation", () => {
    it("rejects when customer is absent", async () => {
      const { payment } = validBody();
      const res = await request(app).post("/checkout").send({ payment });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects when customer is a string", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), customer: "bad" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects when customer is null", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), customer: null });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });
  });

  // ── customerId ─────────────────────────────────────────────────────────────

  describe("customerId validation", () => {
    it("rejects empty customerId", async () => {
      const body = { ...validBody(), customer: { ...validBody().customer, customerId: "" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CUSTOMER_ID");
    });

    it("rejects customerId with spaces", async () => {
      const body = {
        ...validBody(),
        customer: { ...validBody().customer, customerId: "cust 123" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CUSTOMER_ID");
    });

    it("rejects customerId over 255 chars", async () => {
      const body = {
        ...validBody(),
        customer: { ...validBody().customer, customerId: "a".repeat(256) },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CUSTOMER_ID");
    });
  });

  // ── email ──────────────────────────────────────────────────────────────────

  describe("email validation", () => {
    it("rejects email without @", async () => {
      const body = {
        ...validBody(),
        customer: { ...validBody().customer, email: "userexample.com" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_EMAIL");
    });

    it("rejects malformed email (no domain)", async () => {
      const body = {
        ...validBody(),
        customer: { ...validBody().customer, email: "user@" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_EMAIL");
    });

    it("rejects email over 254 chars", async () => {
      const longEmail = `${"a".repeat(200)}@${"b".repeat(100)}.com`;
      const body = {
        ...validBody(),
        customer: { ...validBody().customer, email: longEmail },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_EMAIL");
    });

    it("error details includes field path 'customer.email'", async () => {
      const body = { ...validBody(), customer: { ...validBody().customer, email: "bad" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.details?.field).toBe("customer.email");
    });
  });

  // ── metadata ───────────────────────────────────────────────────────────────

  describe("metadata validation", () => {
    it("rejects metadata that is an array", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), metadata: ["a", "b"] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects metadata that is a plain string", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), metadata: "string-meta" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("passes when metadata is absent (undefined)", async () => {
      const res = await request(app).post("/checkout").send(validBody());
      expect(res.status).toBe(200);
    });

    it("passes when metadata is a valid object", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ ...validBody(), metadata: { key: "value", num: 1 } });
      expect(res.status).toBe(200);
    });
  });

  // ── error response shape ───────────────────────────────────────────────────

  describe("error response contract", () => {
    it("returns success:false on any validation failure", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: 0 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.success).toBe(false);
    });

    it("response includes code, message, and details fields", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, amount: -5 } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body).toHaveProperty("code");
      expect(res.body).toHaveProperty("message");
      expect(typeof res.body.message).toBe("string");
      expect(res.body).toHaveProperty("details");
    });

    it("reports HTTP 400 for all validation errors", async () => {
      const body = { ...validBody(), payment: { ...validBody().payment, currency: "ZZZ" } };
      const res = await request(app).post("/checkout").send(body);
      expect(res.status).toBe(400);
    });
  });

  // ── validation ordering ────────────────────────────────────────────────────

  describe("validation ordering (earlier checks take priority)", () => {
    it("MISSING_REQUIRED_FIELD (payment) fires before INVALID_AMOUNT", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ customer: validBody().customer });
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("INVALID_AMOUNT fires before INVALID_CURRENCY", async () => {
      const body = {
        ...validBody(),
        payment: { ...validBody().payment, amount: 0, currency: "FAKE" },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.code).toBe("INVALID_AMOUNT");
    });

    it("INVALID_ASSET fires before INVALID_CURRENCY when crypto + bad asset + bad currency", async () => {
      const body = {
        ...validBody(),
        payment: {
          ...validBody().payment,
          paymentMethod: "crypto",
          asset: "BAD",
          currency: "FAKE",
        },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.code).toBe("INVALID_ASSET");
    });

    it("INVALID_CURRENCY fires before INVALID_PAYMENT_METHOD", async () => {
      const body = {
        ...validBody(),
        payment: {
          ...validBody().payment,
          currency: "FAKE",
          paymentMethod: "paypal",
        },
      };
      const res = await request(app).post("/checkout").send(body);
      expect(res.body.code).toBe("INVALID_CURRENCY");
    });

    it("MISSING_REQUIRED_FIELD (customer) fires before INVALID_CUSTOMER_ID", async () => {
      const res = await request(app)
        .post("/checkout")
        .send({ payment: validBody().payment });
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSessionIdParam – middleware integration
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSessionIdParam middleware", () => {
  let app: express.Express;

  beforeEach(() => {
    app = makeParamApp(validateSessionIdParam());
  });

  describe("success path", () => {
    it("passes a canonical lowercase UUIDv4", async () => {
      const res = await request(app).get(
        "/sessions/550e8400-e29b-41d4-a716-446655440000",
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("passes an all-zeros UUID", async () => {
      const res = await request(app).get(
        "/sessions/00000000-0000-4000-8000-000000000000",
      );
      expect(res.status).toBe(200);
    });

    it("passes an uppercase hex UUID (regex is case-insensitive)", async () => {
      const res = await request(app).get(
        "/sessions/550E8400-E29B-41D4-A716-446655440000",
      );
      expect(res.status).toBe(200);
    });
  });

  describe("failure paths", () => {
    it("rejects a plain non-UUID string", async () => {
      const res = await request(app).get("/sessions/not-a-uuid");
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("MISSING_REQUIRED_FIELD");
    });

    it("rejects a UUID missing the last segment", async () => {
      const res = await request(app).get(
        "/sessions/550e8400-e29b-41d4-a716",
      );
      expect(res.status).toBe(400);
    });

    it("rejects an extra segment appended to a valid UUID", async () => {
      const res = await request(app).get(
        "/sessions/550e8400-e29b-41d4-a716-446655440000-extra",
      );
      expect(res.status).toBe(400);
    });

    it("rejects a raw 32-char hex string without hyphens", async () => {
      const res = await request(app).get(
        "/sessions/550e8400e29b41d4a716446655440000",
      );
      expect(res.status).toBe(400);
    });
  });

  describe("error response contract", () => {
    it("returns success:false with code and message on invalid session ID", async () => {
      const res = await request(app).get("/sessions/bad-id");
      expect(res.body.success).toBe(false);
      expect(res.body).toHaveProperty("code");
      expect(res.body).toHaveProperty("message");
    });

    it("returns HTTP 400", async () => {
      const res = await request(app).get("/sessions/not-a-uuid-at-all");
      expect(res.status).toBe(400);
    });
  });
});

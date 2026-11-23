/**
 * Regression suite for the outbound-call error family.
 *
 * These errors are the contract every upstream integration failure resolves to,
 * so this suite pins:
 * - the exact message text produced with and without a `service` argument,
 * - the HTTP status / error-code / operational flags each subclass binds to,
 * - the `toJSON()` envelope shape used on the wire,
 * - the falsy-argument boundaries (empty string / undefined are treated alike,
 *   because every constructor branches on truthiness rather than on `typeof`),
 * - the taxonomy linkage, which is currently absent for these three codes.
 *
 * Nothing here asks the source to change; it only makes the existing behaviour
 * observable and deterministic so a silent edit to the messages or statuses
 * fails loudly.
 */

import { describe, it, expect } from "@jest/globals";
import {
  OutboundTimeoutError,
  OutboundUnavailableError,
  OutboundBadResponseError,
} from "../OutboundErrors.js";
import { AppError, getStatusCode, isAppError } from "../AppError.js";
import { ERROR_TAXONOMY } from "../errorCodes.js";

describe("OutboundErrors", () => {
  // ---------------------------------------------------------------------
  // Shared class-level contract
  // ---------------------------------------------------------------------
  describe("class contract", () => {
    const cases = [
      { name: "OutboundTimeoutError", make: () => new OutboundTimeoutError() },
      { name: "OutboundUnavailableError", make: () => new OutboundUnavailableError() },
      { name: "OutboundBadResponseError", make: () => new OutboundBadResponseError("svc") },
    ] as const;

    for (const { name, make } of cases) {
      describe(name, () => {
        it("is an AppError and an Error", () => {
          const err = make();
          expect(err).toBeInstanceOf(Error);
          expect(err).toBeInstanceOf(AppError);
          expect(isAppError(err)).toBe(true);
        });

        it("reports name = constructor name", () => {
          expect(make().name).toBe(name);
        });

        it("flags itself operational so it is handled, not treated as a crash", () => {
          expect(make().isOperational).toBe(true);
        });

        it("captures a stack trace in non-production environments", () => {
          expect(typeof make().stack).toBe("string");
          expect(make().stack?.length ?? 0).toBeGreaterThan(0);
        });

        it("stamps an ISO-8601 timestamp that parses", () => {
          const { timestamp } = make();
          expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(Number.isNaN(Date.parse(timestamp))).toBe(false);
        });
      });
    }
  });

  // ---------------------------------------------------------------------
  // OutboundTimeoutError — 504
  // ---------------------------------------------------------------------
  describe("OutboundTimeoutError", () => {
    it("falls back to a generic message when no service is supplied", () => {
      const err = new OutboundTimeoutError();
      expect(err.message).toBe("Outbound request timed out");
    });

    it("names the service in the message when one is supplied", () => {
      const err = new OutboundTimeoutError("payments");
      expect(err.message).toBe("Request to payments timed out");
    });

    it("binds to HTTP 504 and the OUTBOUND_TIMEOUT code", () => {
      const err = new OutboundTimeoutError("payments");
      expect(err.statusCode).toBe(504);
      expect(err.code).toBe("OUTBOUND_TIMEOUT");
    });

    it("treats an empty service name as absent (falsy boundary)", () => {
      const err = new OutboundTimeoutError("");
      expect(err.message).toBe("Outbound request timed out");
    });

    it("treats an explicitly undefined service as absent", () => {
      const err = new OutboundTimeoutError(undefined);
      expect(err.message).toBe("Outbound request timed out");
    });

    it("returns 504 through getStatusCode()", () => {
      expect(getStatusCode(new OutboundTimeoutError("payments"))).toBe(504);
    });
  });

  // ---------------------------------------------------------------------
  // OutboundUnavailableError — 503
  // ---------------------------------------------------------------------
  describe("OutboundUnavailableError", () => {
    it("falls back to a generic message when no service is supplied", () => {
      const err = new OutboundUnavailableError();
      expect(err.message).toBe("External service is currently unavailable");
    });

    it("names the service in the message when one is supplied", () => {
      const err = new OutboundUnavailableError("ledger");
      expect(err.message).toBe("ledger is currently unavailable");
    });

    it("binds to HTTP 503 and the OUTBOUND_UNAVAILABLE code", () => {
      const err = new OutboundUnavailableError("ledger");
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe("OUTBOUND_UNAVAILABLE");
    });

    it("treats an empty service name as absent (falsy boundary)", () => {
      const err = new OutboundUnavailableError("");
      expect(err.message).toBe("External service is currently unavailable");
    });

    it("returns 503 through getStatusCode()", () => {
      expect(getStatusCode(new OutboundUnavailableError("ledger"))).toBe(503);
    });
  });

  // ---------------------------------------------------------------------
  // OutboundBadResponseError — 502
  // ---------------------------------------------------------------------
  describe("OutboundBadResponseError", () => {
    it("names the service and omits the detail suffix when no details are given", () => {
      const err = new OutboundBadResponseError("webhooks");
      expect(err.message).toBe("Invalid response from webhooks");
    });

    it("appends the details after a colon when details are supplied", () => {
      const err = new OutboundBadResponseError("webhooks", "missing signature header");
      expect(err.message).toBe("Invalid response from webhooks: missing signature header");
    });

    it("binds to HTTP 502 and the OUTBOUND_BAD_RESPONSE code", () => {
      const err = new OutboundBadResponseError("webhooks", "bad payload");
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe("OUTBOUND_BAD_RESPONSE");
    });

    it("treats an empty details string as absent (falsy boundary)", () => {
      const err = new OutboundBadResponseError("webhooks", "");
      expect(err.message).toBe("Invalid response from webhooks");
    });

    it("does not validate the service argument: an empty name is formatted verbatim", () => {
      // Pins current behaviour. `service` is a required parameter with no
      // guard, so an empty string yields a trailing-space message rather than
      // throwing. Recorded here so a future guard is a deliberate decision.
      const err = new OutboundBadResponseError("");
      expect(err.message).toBe("Invalid response from ");
    });

    it("keeps details in the message only, not in the envelope details field", () => {
      const err = new OutboundBadResponseError("webhooks", "bad payload");
      const json = err.toJSON();
      expect(err.details).toBeUndefined();
      expect("details" in json).toBe(false);
    });

    it("returns 502 through getStatusCode()", () => {
      expect(getStatusCode(new OutboundBadResponseError("webhooks"))).toBe(502);
    });
  });

  // ---------------------------------------------------------------------
  // Wire envelope
  // ---------------------------------------------------------------------
  describe("toJSON() envelope", () => {
    const cases = [
      {
        label: "timeout",
        err: new OutboundTimeoutError("payments"),
        statusCode: 504,
        code: "OUTBOUND_TIMEOUT",
        message: "Request to payments timed out",
      },
      {
        label: "unavailable",
        err: new OutboundUnavailableError("ledger"),
        statusCode: 503,
        code: "OUTBOUND_UNAVAILABLE",
        message: "ledger is currently unavailable",
      },
      {
        label: "bad response",
        err: new OutboundBadResponseError("webhooks", "bad payload"),
        statusCode: 502,
        code: "OUTBOUND_BAD_RESPONSE",
        message: "Invalid response from webhooks: bad payload",
      },
    ] as const;

    for (const { label, err, code, message } of cases) {
      it(`emits the flat failure envelope for ${label}`, () => {
        const json = err.toJSON();
        expect(json).toEqual({
          success: false,
          code,
          message,
          error: message,
          timestamp: err.timestamp,
        });
      });

      it(`keeps the envelope free of a details key for ${label}`, () => {
        expect(Object.keys(err.toJSON()).sort()).toEqual(
          ["code", "error", "message", "success", "timestamp"].sort(),
        );
      });
    }

    it("serialises cleanly through JSON.stringify", () => {
      const err = new OutboundTimeoutError("payments");
      const roundTripped = JSON.parse(JSON.stringify(err.toJSON()));
      expect(roundTripped.success).toBe(false);
      expect(roundTripped.code).toBe("OUTBOUND_TIMEOUT");
      expect(roundTripped.message).toBe("Request to payments timed out");
    });
  });

  // ---------------------------------------------------------------------
  // Message stability
  // ---------------------------------------------------------------------
  describe("deterministic messages", () => {
    it("produces identical text for identical inputs", () => {
      expect(new OutboundTimeoutError("payments").message).toBe(
        new OutboundTimeoutError("payments").message,
      );
      expect(new OutboundUnavailableError("ledger").message).toBe(
        new OutboundUnavailableError("ledger").message,
      );
      expect(new OutboundBadResponseError("webhooks", "x").message).toBe(
        new OutboundBadResponseError("webhooks", "x").message,
      );
    });

    it("does not resolve messages through the i18n catalogue", () => {
      // The message is built in the constructor, so it must be byte-identical
      // regardless of the message loader. A non-ASCII, non-catalogue service
      // name round-trips untouched.
      const err = new OutboundTimeoutError("payments-service-\u00e9");
      expect(err.message).toBe("Request to payments-service-\u00e9 timed out");
    });
  });

  // ---------------------------------------------------------------------
  // Taxonomy linkage
  // ---------------------------------------------------------------------
  describe("taxonomy linkage", () => {
    const codes = ["OUTBOUND_TIMEOUT", "OUTBOUND_UNAVAILABLE", "OUTBOUND_BAD_RESPONSE"];

    it("uses codes that are NOT in the canonical ERROR_TAXONOMY", () => {
      // Pins current behaviour so that adding these codes to the taxonomy is a
      // deliberate, test-visible decision rather than a silent side effect.
      for (const code of codes) {
        expect(code in ERROR_TAXONOMY).toBe(false);
      }
    });

    it("leaves taxonomyError undefined and isPublic() false as a consequence", () => {
      // Because AppError only links a taxonomy entry for a code it recognises,
      // these outbound errors are reported as non-public. Recorded explicitly:
      // it is the observable contract today, not an endorsement.
      const errs = [
        new OutboundTimeoutError("payments"),
        new OutboundUnavailableError("ledger"),
        new OutboundBadResponseError("webhooks"),
      ];
      for (const err of errs) {
        expect(err.taxonomyError).toBeUndefined();
        expect(err.isPublic()).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------
  // Cross-family disambiguation
  // ---------------------------------------------------------------------
  describe("cross-family disambiguation", () => {
    it("distinguishes the three subclasses from one another", () => {
      const timeout = new OutboundTimeoutError("svc");
      const unavailable = new OutboundUnavailableError("svc");
      const badResponse = new OutboundBadResponseError("svc");

      expect(timeout).not.toBeInstanceOf(OutboundUnavailableError);
      expect(timeout).not.toBeInstanceOf(OutboundBadResponseError);
      expect(unavailable).not.toBeInstanceOf(OutboundTimeoutError);
      expect(unavailable).not.toBeInstanceOf(OutboundBadResponseError);
      expect(badResponse).not.toBeInstanceOf(OutboundTimeoutError);
      expect(badResponse).not.toBeInstanceOf(OutboundUnavailableError);
    });

    it("routes each family member to its own HTTP status", () => {
      const statuses = [
        new OutboundTimeoutError("svc").statusCode,
        new OutboundUnavailableError("svc").statusCode,
        new OutboundBadResponseError("svc").statusCode,
      ];
      expect(statuses).toEqual([504, 503, 502]);
      expect(new Set(statuses).size).toBe(3);
    });

    it("survives instanceof checks after crossing an async boundary", async () => {
      const thrown = await Promise.resolve()
        .then(() => {
          throw new OutboundTimeoutError("payments");
        })
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(OutboundTimeoutError);
      expect(getStatusCode(thrown)).toBe(504);
    });
  });
});

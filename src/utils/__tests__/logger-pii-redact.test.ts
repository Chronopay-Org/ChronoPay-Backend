/**
 * PII-redaction tests for the pino logger (#593)
 *
 * Verifies that buyer.name / buyer.email / buyer.phone are stripped from
 * every log line produced by the logger before they can reach a log store.
 *
 * Strategy: we capture raw JSON written to a writable stream and parse it,
 * bypassing pino-pretty so assertions are deterministic in every environment.
 */

import { Writable } from "stream";
import pino from "pino";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a pino instance that writes to an in-memory buffer using the same
 * redact config as the application logger (src/utils/logger.ts).
 *
 * We intentionally mirror createLoggerConfig() rather than importing the
 * singleton so that the test is self-contained and isolated from env state.
 */
function buildTestLogger() {
  const lines: string[] = [];

  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const instance = pino(
    {
      level: "trace",
      redact: {
        paths: [
          // HTTP transport headers (kept from baseline config)
          "headers.authorization",
          "headers.cookie",
          "headers['x-api-key']",
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-api-key']",
          // Generic body secrets
          "body.password",
          "body.secret",
          "query.token",
          // Buyer PII — top-level buyer object (booking-intent payload)
          "buyer.name",
          "buyer.email",
          "buyer.phone",
          // Buyer PII — arrays of buyers (e.g. bulk intents)
          "buyers[*].name",
          "buyers[*].email",
          "buyers[*].phone",
          // Nested inside intent or booking objects
          "intent.buyer.name",
          "intent.buyer.email",
          "intent.buyer.phone",
          "booking.buyer.name",
          "booking.buyer.email",
          "booking.buyer.phone",
        ],
        remove: true,
      },
    },
    destination,
  );

  /** Flush the buffer and return parsed JSON objects for all lines written. */
  const flush = (): Record<string, unknown>[] =>
    lines.splice(0).map((l) => JSON.parse(l.trim()));

  return { instance, flush };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logger PII redaction – buyer booking-intent payloads", () => {
  const { instance: log, flush } = buildTestLogger();

  // -- top-level buyer object -----------------------------------------------

  describe("top-level buyer object", () => {
    it("removes buyer.name, buyer.email and buyer.phone", () => {
      log.info({
        event: "booking_intent.created",
        slotId: "slot-100",
        buyer: {
          name: "Alice Smith",
          email: "alice@example.com",
          phone: "+15550001234",
        },
      });

      const [record] = flush();
      expect(record.buyer).toBeDefined();
      expect((record.buyer as Record<string, unknown>).name).toBeUndefined();
      expect((record.buyer as Record<string, unknown>).email).toBeUndefined();
      expect((record.buyer as Record<string, unknown>).phone).toBeUndefined();
    });

    it("preserves non-PII structural fields on the buyer object", () => {
      log.info({
        event: "booking_intent.created",
        slotId: "slot-101",
        buyer: {
          id: "buyer-42",
          name: "Bob Jones",
          email: "bob@example.com",
          phone: "+15550009999",
          tier: "premium",
        },
      });

      const [record] = flush();
      const buyer = record.buyer as Record<string, unknown>;
      expect(buyer.id).toBe("buyer-42");
      expect(buyer.tier).toBe("premium");
      expect(buyer.name).toBeUndefined();
      expect(buyer.email).toBeUndefined();
      expect(buyer.phone).toBeUndefined();
    });

    it("preserves non-buyer top-level fields intact", () => {
      log.info({
        event: "booking_intent.created",
        slotId: "slot-102",
        requestId: "req-abc",
        buyer: { name: "Carol", email: "carol@example.com", phone: "+1555" },
      });

      const [record] = flush();
      expect(record.slotId).toBe("slot-102");
      expect(record.requestId).toBe("req-abc");
      expect(record.event).toBe("booking_intent.created");
    });
  });

  // -- arrays of buyers (bulk intents) --------------------------------------

  describe("arrays of buyers – buyers[*]", () => {
    it("removes PII from every element in a buyers array", () => {
      log.info({
        event: "bulk_intent.queued",
        buyers: [
          { id: "b-1", name: "Dave", email: "dave@example.com", phone: "+1111" },
          { id: "b-2", name: "Eve", email: "eve@example.com", phone: "+2222" },
          { id: "b-3", name: "Frank", email: "frank@example.com", phone: "+3333" },
        ],
      });

      const [record] = flush();
      const buyers = record.buyers as Record<string, unknown>[];
      expect(buyers).toHaveLength(3);
      for (const b of buyers) {
        expect(b.name).toBeUndefined();
        expect(b.email).toBeUndefined();
        expect(b.phone).toBeUndefined();
        // structural id is preserved
        expect(typeof b.id).toBe("string");
      }
    });

    it("handles an empty buyers array without error", () => {
      log.info({ event: "bulk_intent.queued", buyers: [] });
      const [record] = flush();
      expect(record.buyers).toEqual([]);
    });
  });

  // -- nested intent / booking wrappers -------------------------------------

  describe("nested intent.buyer and booking.buyer paths", () => {
    it("removes PII when buyer is nested under intent", () => {
      log.info({
        event: "intent.confirmed",
        intent: {
          id: "intent-99",
          buyer: {
            name: "Grace",
            email: "grace@example.com",
            phone: "+9999",
          },
        },
      });

      const [record] = flush();
      const intentBuyer = (record.intent as Record<string, unknown>).buyer as Record<string, unknown>;
      expect(intentBuyer.name).toBeUndefined();
      expect(intentBuyer.email).toBeUndefined();
      expect(intentBuyer.phone).toBeUndefined();
      // non-PII intent field intact
      expect((record.intent as Record<string, unknown>).id).toBe("intent-99");
    });

    it("removes PII when buyer is nested under booking", () => {
      log.info({
        event: "booking.confirmed",
        booking: {
          id: "booking-7",
          buyer: {
            name: "Heidi",
            email: "heidi@example.com",
            phone: "+4444",
          },
        },
      });

      const [record] = flush();
      const bookingBuyer = (record.booking as Record<string, unknown>).buyer as Record<string, unknown>;
      expect(bookingBuyer.name).toBeUndefined();
      expect(bookingBuyer.email).toBeUndefined();
      expect(bookingBuyer.phone).toBeUndefined();
    });
  });

  // -- edge cases -----------------------------------------------------------

  describe("edge cases", () => {
    it("handles missing buyer fields gracefully (partial payload)", () => {
      // Only email present — the other two fields simply don't exist
      log.info({
        event: "booking_intent.created",
        slotId: "slot-200",
        buyer: { id: "b-partial", email: "partial@example.com" },
      });

      const [record] = flush();
      const buyer = record.buyer as Record<string, unknown>;
      expect(buyer.email).toBeUndefined();
      expect(buyer.id).toBe("b-partial");
    });

    it("handles buyer being null without throwing", () => {
      expect(() => {
        log.info({ event: "booking_intent.created", buyer: null });
      }).not.toThrow();
      flush();
    });

    it("handles buyer being undefined without throwing", () => {
      expect(() => {
        log.info({ event: "booking_intent.created" });
      }).not.toThrow();
      flush();
    });

    it("handles non-string phone value (number) — field is removed", () => {
      log.info({
        buyer: { id: "b-99", name: "Ivan", email: "ivan@x.com", phone: 15559998888 as unknown as string },
      });

      const [record] = flush();
      const buyer = record.buyer as Record<string, unknown>;
      expect(buyer.phone).toBeUndefined();
    });

    it("does not redact an unrelated field named 'phonetics'", () => {
      // Ensures the path matcher is exact, not a substring match
      log.info({ buyer: { id: "b-x", phonetics: "Ahy-liss" } });
      const [record] = flush();
      const buyer = record.buyer as Record<string, unknown>;
      expect(buyer.phonetics).toBe("Ahy-liss");
    });
  });
});

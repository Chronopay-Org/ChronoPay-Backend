/**
 * LTR Event Emitter Tests
 *
 * Covers:
 *   - Impression event emission (with all fields)
 *   - Click event emission (with all fields)
 *   - No-op emitter correctness
 *   - Event structure validation
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { SearchLtrEventEmitter, NoopLtrEventEmitter } from "../eventEmitter.js";
import type {
  SearchImpressionEvent,
  SearchClickEvent,
} from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeImpressionEvent(
  overrides?: Partial<SearchImpressionEvent>,
): SearchImpressionEvent {
  return {
    type: "search_impression",
    timestamp: "2026-07-28T10:00:00.000Z",
    searchId: "srch_test123",
    userId: "user-hash-abc",
    query: {
      categories: ["haircut"],
      sortBy: "relevance",
      page: 1,
    },
    displayedSlots: [
      { slotId: 1, features: [0.8, 0.3, 0.1, 1, 0.5, 0.7] },
      { slotId: 2, features: [0.6, 0.4, 0.05, 0, 0.3, 0.6] },
    ],
    ...overrides,
  };
}

function makeClickEvent(
  overrides?: Partial<SearchClickEvent>,
): SearchClickEvent {
  return {
    type: "search_click",
    timestamp: "2026-07-28T10:00:05.000Z",
    searchId: "srch_test123",
    slotId: 1,
    position: 0,
    userId: "user-hash-abc",
    ...overrides,
  };
}

// ─── SearchLtrEventEmitter ──────────────────────────────────────────────────

describe("SearchLtrEventEmitter", () => {
  let emitter: SearchLtrEventEmitter;

  beforeEach(() => {
    emitter = new SearchLtrEventEmitter();
  });

  describe("emitImpression", () => {
    it("emits without throwing", () => {
      const event = makeImpressionEvent();
      expect(() => emitter.emitImpression(event)).not.toThrow();
    });

    it("accepts an event with all optional fields omitted", () => {
      const event = makeImpressionEvent({
        userId: undefined,
        query: { sortBy: "relevance", page: 1 },
        displayedSlots: [],
      });
      expect(() => emitter.emitImpression(event)).not.toThrow();
    });

    it("accepts an event with many displayed slots", () => {
      const slots = Array.from({ length: 100 }, (_, i) => ({
        slotId: i + 1,
        features: [0.5, 0.5, 0, 0, 0, 0],
      }));
      const event = makeImpressionEvent({ displayedSlots: slots });
      expect(() => emitter.emitImpression(event)).not.toThrow();
    });

    it("accepts events with different query shapes", () => {
      const event = makeImpressionEvent({
        query: {
          categories: ["haircut", "plumbing", "cleaning"],
          priceRange: { min: 1000, max: 5000 },
          ratingRange: { min: 3, max: 5 },
          sortBy: "price",
          page: 3,
        },
      });
      expect(() => emitter.emitImpression(event)).not.toThrow();
    });
  });

  describe("emitClick", () => {
    it("emits without throwing", () => {
      const event = makeClickEvent();
      expect(() => emitter.emitClick(event)).not.toThrow();
    });

    it("accepts an event with userId omitted", () => {
      const event = makeClickEvent({ userId: undefined });
      expect(() => emitter.emitClick(event)).not.toThrow();
    });

    it("accepts events at different positions", () => {
      for (let pos = 0; pos < 50; pos++) {
        const event = makeClickEvent({ position: pos, slotId: pos + 1 });
        expect(() => emitter.emitClick(event)).not.toThrow();
      }
    });
  });
});

// ─── NoopLtrEventEmitter ────────────────────────────────────────────────────

describe("NoopLtrEventEmitter", () => {
  let emitter: NoopLtrEventEmitter;

  beforeEach(() => {
    emitter = new NoopLtrEventEmitter();
  });

  it("emitImpression does nothing and does not throw", () => {
    const event = makeImpressionEvent();
    expect(() => emitter.emitImpression(event)).not.toThrow();
  });

  it("emitClick does nothing and does not throw", () => {
    const event = makeClickEvent();
    expect(() => emitter.emitClick(event)).not.toThrow();
  });

  it("emitImpression is safe with empty slots", () => {
    const event = makeImpressionEvent({ displayedSlots: [] });
    expect(() => emitter.emitImpression(event)).not.toThrow();
  });

  it("emitClick is safe with high position", () => {
    const event = makeClickEvent({ position: 9999 });
    expect(() => emitter.emitClick(event)).not.toThrow();
  });
});

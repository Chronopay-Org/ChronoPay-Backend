/**
 * Unit tests for SlotService (src/services/slotService.ts)
 *
 * Layer:   Unit — no HTTP, no Redis, no DB
 * Scope:   SlotService class: create, list, update, reset, cache behaviour,
 *          validation errors, not-found errors, immutability guarantees
 *
 * Security paths covered:
 *   - Input validation rejects null/non-object payloads (prevents prototype pollution)
 *   - Non-finite time values rejected (prevents NaN/Infinity in stored data)
 *   - Reversed time ranges rejected (business-rule invariant)
 *   - Empty/whitespace-only professional rejected (prevents blank records)
 *   - Update on unknown id throws SlotNotFoundError (no silent no-ops)
 */

import { describe, it, expect, beforeEach } from "@jest/globals";

import { InMemoryCache } from "../cache/inMemoryCache.js";
import {
  SLOT_LIST_CACHE_TTL_MS,
  SlotNotFoundError,
  SlotService,
  SlotValidationError,
  type SlotData,
} from "../services/slotService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeService(clockMs?: number) {
  let currentTime = clockMs ?? Date.parse("2026-03-28T00:00:00.000Z");

  const cache = new InMemoryCache<SlotData[]>({
    ttlMs: SLOT_LIST_CACHE_TTL_MS,
    maxEntries: 10,
    clock: () => currentTime,
  });

  const service = new SlotService(cache, () => new Date(currentTime));

  return {
    service,
    advanceClock: (ms: number) => {
      currentTime += ms;
    },
  };
}

// ─── Cache behaviour ──────────────────────────────────────────────────────────

describe("SlotService — cache behaviour", () => {
  it("returns miss on first read, hit on second read", async () => {
    const { service } = makeService();

    await expect(service.listSlots()).resolves.toMatchObject({ slots: [], cache: "miss" });
    await expect(service.listSlots()).resolves.toMatchObject({ slots: [], cache: "hit" });
  });

  it("invalidates the cached list after creating a slot", async () => {
    const { service } = makeService();

    await service.listSlots(); // prime cache

    service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    await expect(service.listSlots()).resolves.toMatchObject({
      cache: "miss",
      slots: [expect.objectContaining({ professional: "alice" })],
    });
  });

  it("invalidates the cached list after updating a slot", async () => {
    const { service } = makeService();

    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });
    await service.listSlots(); // prime cache

    service.updateSlot(slot.id, { professional: "bob" });

    await expect(service.listSlots()).resolves.toMatchObject({
      cache: "miss",
      slots: [expect.objectContaining({ professional: "bob" })],
    });
  });

  it("returns clones so callers cannot mutate cached state", async () => {
    const { service } = makeService();

    service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    const first = await service.listSlots();
    first.slots[0].professional = "tampered";

    const second = await service.listSlots();
    expect(second.slots[0].professional).toBe("alice");
  });
});

// ─── Create slot ──────────────────────────────────────────────────────────────

describe("SlotService — createSlot", () => {
  it("creates slots and returns them in insertion order", async () => {
    const { service, advanceClock } = makeService();

    const first = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });
    advanceClock(1_000);
    const second = service.createSlot({ professional: "bob", startTime: 3_000, endTime: 4_000 });

    const { slots } = await service.listSlots();
    expect(slots.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it("trims whitespace from professional name", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "  alice  ", startTime: 1_000, endTime: 2_000 });
    expect(slot.professional).toBe("alice");
  });

  it("assigns auto-incrementing ids starting at 1", () => {
    const { service } = makeService();
    const a = service.createSlot({ professional: "a", startTime: 1_000, endTime: 2_000 });
    const b = service.createSlot({ professional: "b", startTime: 3_000, endTime: 4_000 });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  // ── Validation (security) ──────────────────────────────────────────────────

  it("rejects empty / whitespace-only professional", () => {
    const { service } = makeService();
    expect(() =>
      service.createSlot({ professional: "   ", startTime: 1_000, endTime: 2_000 }),
    ).toThrow("professional must be a non-empty string");
  });

  it("rejects non-finite startTime", () => {
    const { service } = makeService();
    expect(() =>
      service.createSlot({ professional: "alice", startTime: Number.NaN, endTime: 2_000 }),
    ).toThrow("startTime and endTime must be finite numbers");
  });

  it("rejects non-finite endTime", () => {
    const { service } = makeService();
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 1_000, endTime: Infinity }),
    ).toThrow("startTime and endTime must be finite numbers");
  });

  it("rejects reversed time ranges", () => {
    const { service } = makeService();
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 2_000, endTime: 1_000 }),
    ).toThrow(SlotValidationError);
  });
});

// ─── Update slot ──────────────────────────────────────────────────────────────

describe("SlotService — updateSlot", () => {
  it("updates professional, startTime, and endTime independently", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    const updated = service.updateSlot(slot.id, { professional: " bob ", endTime: 2_200 });

    expect(updated.professional).toBe("bob");
    expect(updated.startTime).toBe(1_000); // unchanged
    expect(updated.endTime).toBe(2_200);
  });

  it("sets updatedAt to a later timestamp than createdAt", () => {
    const { service, advanceClock } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    advanceClock(5_000);
    const updated = service.updateSlot(slot.id, { endTime: 2_200 });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(updated.createdAt.getTime());
  });

  it("throws SlotValidationError when payload is null", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    expect(() =>
      service.updateSlot(slot.id, null as unknown as { professional: string }),
    ).toThrow(SlotValidationError);
  });

  it("throws SlotValidationError when professional has wrong type", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    expect(() =>
      service.updateSlot(slot.id, { professional: 123 as unknown as string }),
    ).toThrow("professional must be a string");
  });

  it("throws SlotValidationError when startTime is NaN", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    expect(() => service.updateSlot(slot.id, { startTime: Number.NaN })).toThrow(
      "startTime and endTime must be finite numbers",
    );
  });

  it("throws SlotValidationError when update creates reversed range", () => {
    const { service } = makeService();
    const slot = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });

    expect(() => service.updateSlot(slot.id, { endTime: 500 })).toThrow(SlotValidationError);
  });

  it("throws SlotNotFoundError for unknown slot id", () => {
    const { service } = makeService();
    expect(() => service.updateSlot(999, { endTime: 1_000 })).toThrow(SlotNotFoundError);
  });
});

// ─── Reset ────────────────────────────────────────────────────────────────────

describe("SlotService — reset", () => {
  it("clears all slots and resets id counter to 1", async () => {
    const { service } = makeService();

    service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });
    service.reset();

    const { slots } = await service.listSlots();
    expect(slots).toEqual([]);

    const recreated = service.createSlot({ professional: "alice", startTime: 1_000, endTime: 2_000 });
    expect(recreated.id).toBe(1);
  });

  it("clears the cache so the next read is a miss", async () => {
    const { service } = makeService();

    await service.listSlots(); // prime cache
    service.reset();

    await expect(service.listSlots()).resolves.toMatchObject({ cache: "miss" });
  });
});

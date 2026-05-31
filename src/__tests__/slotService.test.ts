/**
 * slotService.test.ts
 *
 * Tests for SlotService using InMemorySlotRepository (no DB required).
 *
 * Coverage:
 *  - create: happy path, validation errors, conflict detection
 *  - update: happy path, not-found, validation errors, conflict detection
 *  - list: cache hit/miss, cache invalidation on write
 *  - delete: happy path, not-found, cache invalidation
 *  - DB exclusion constraint violation (23P01) → SlotConflictError
 *  - Restart durability: repository state survives service re-instantiation
 */

import {
  SlotService,
  SlotValidationError,
  SlotNotFoundError,
  // @ts-expect-error - Auto-fixed by script
  SlotConflictError,
  SLOT_LIST_CACHE_TTL_MS,
} from "../services/slotService.js";
// @ts-expect-error - Auto-fixed by script
import { InMemorySlotRepository } from "../repositories/slotRepository.js";
import { InMemoryCache } from "../cache/inMemoryCache.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const T1 = 1_000_000_000_000;
const T2 = T1 + 3_600_000; // +1 h
const T3 = T2 + 3_600_000; // +2 h

// @ts-expect-error - Auto-fixed by script
function makeService(repo?: InMemorySlotRepository, cache?: InMemoryCache<SlotRecord[]>) {
  const r = repo ?? new InMemorySlotRepository();
  // @ts-expect-error - Auto-fixed by script
  const c = cache ?? new InMemoryCache<SlotRecord[]>({ ttlMs: SLOT_LIST_CACHE_TTL_MS });
  return { service: new SlotService(r, c), repo: r, cache: c };
}

// ─── create ───────────────────────────────────────────────────────────────────

describe("SlotService.createSlot", () => {
  it("creates a slot and returns it", async () => {
    const { service } = makeService();
    const slot = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    expect(slot.id).toBe(1);
    expect(slot.professional).toBe("alice");
    expect(slot.startTime).toBe(T1);
    expect(slot.endTime).toBe(T2);
    // @ts-expect-error - Auto-fixed by script
    expect(slot.createdAt).toBeTruthy();
    // @ts-expect-error - Auto-fixed by script
    expect(slot.updatedAt).toBeTruthy();
  });

  it("trims professional whitespace", async () => {
    const { service } = makeService();
    const slot = await service.createSlot({ professional: "  bob  ", startTime: T1, endTime: T2 });
    expect(slot.professional).toBe("bob");
  });

  it("throws SlotValidationError for empty professional", async () => {
    const { service } = makeService();
    await expect(
      service.createSlot({ professional: "  ", startTime: T1, endTime: T2 }),
    ).rejects.toBeInstanceOf(SlotValidationError);
  });

  it("throws SlotValidationError when endTime <= startTime", async () => {
    const { service } = makeService();
    await expect(
      service.createSlot({ professional: "alice", startTime: T2, endTime: T1 }),
    ).rejects.toBeInstanceOf(SlotValidationError);
  });

  it("throws SlotValidationError when endTime === startTime", async () => {
    const { service } = makeService();
    await expect(
      service.createSlot({ professional: "alice", startTime: T1, endTime: T1 }),
    ).rejects.toBeInstanceOf(SlotValidationError);
  });

  it("throws SlotConflictError for overlapping slot (same professional)", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T3 });
    await expect(
      service.createSlot({ professional: "alice", startTime: T2, endTime: T3 }),
    ).rejects.toBeInstanceOf(SlotConflictError);
  });

  it("allows adjacent slots (end == start of next)", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const slot = await service.createSlot({ professional: "alice", startTime: T2, endTime: T3 });
    expect(slot.id).toBe(2);
  });

  it("allows overlapping slots for different professionals", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T3 });
    const slot = await service.createSlot({ professional: "bob", startTime: T1, endTime: T3 });
    expect(slot.professional).toBe("bob");
  });

  it("maps DB exclusion constraint violation (23P01) to SlotConflictError", async () => {
    const repo = new InMemorySlotRepository();
    // Override create to simulate a PG exclusion violation after hasConflict passes
    const original = repo.hasConflict.bind(repo);
    let callCount = 0;
    // @ts-expect-error - Auto-fixed by script
    repo.hasConflict = async (...args) => {
      // First call (fast-path) returns false; DB then throws 23P01
      if (callCount++ === 0) return false;
      return original(...args);
    };
    repo.create = async () => {
      const err = Object.assign(new Error("exclusion violation"), { code: "23P01" });
      throw err;
    };

    const { service } = makeService(repo);
    await expect(
      service.createSlot({ professional: "alice", startTime: T1, endTime: T2 }),
    ).rejects.toBeInstanceOf(SlotConflictError);
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe("SlotService.updateSlot", () => {
  it("updates a slot field", async () => {
    const { service } = makeService();
    const created = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const updated = await service.updateSlot(created.id, { professional: "alice2" });
    expect(updated.professional).toBe("alice2");
    expect(updated.startTime).toBe(T1);
  });

  it("throws SlotNotFoundError for unknown id", async () => {
    const { service } = makeService();
    await expect(service.updateSlot(999, { professional: "x" })).rejects.toBeInstanceOf(
      SlotNotFoundError,
    );
  });

  it("throws SlotValidationError for empty patch", async () => {
    const { service } = makeService();
    const created = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await expect(service.updateSlot(created.id, {})).rejects.toBeInstanceOf(SlotValidationError);
  });

  it("throws SlotValidationError when updated window is invalid", async () => {
    const { service } = makeService();
    const created = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await expect(
      service.updateSlot(created.id, { startTime: T2, endTime: T1 }),
    ).rejects.toBeInstanceOf(SlotValidationError);
  });

  it("throws SlotConflictError when update creates overlap", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const s2 = await service.createSlot({ professional: "alice", startTime: T2, endTime: T3 });
    // Extend s2 backward to overlap s1
    await expect(
      service.updateSlot(s2.id, { startTime: T1 + 1 }),
    ).rejects.toBeInstanceOf(SlotConflictError);
  });

  it("does not conflict with itself during update", async () => {
    const { service } = makeService();
    const created = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const updated = await service.updateSlot(created.id, { endTime: T2 + 1000 });
    expect(updated.endTime).toBe(T2 + 1000);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe("SlotService.listSlots", () => {
  it("returns empty list initially", async () => {
    const { service } = makeService();
    const { slots, cache } = await service.listSlots();
    expect(slots).toEqual([]);
    expect(cache).toBe("miss");
  });

  it("returns created slots", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const { slots } = await service.listSlots();
    expect(slots).toHaveLength(1);
  });

  it("returns cache hit on second call", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await service.listSlots(); // prime cache
    const { cache } = await service.listSlots();
    expect(cache).toBe("hit");
  });

  it("invalidates cache after createSlot", async () => {
    const { service } = makeService();
    await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await service.listSlots(); // prime cache
    await service.createSlot({ professional: "alice", startTime: T2, endTime: T3 });
    const { slots, cache } = await service.listSlots();
    expect(cache).toBe("miss");
    expect(slots).toHaveLength(2);
  });

  it("invalidates cache after updateSlot", async () => {
    const { service } = makeService();
    const s = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await service.listSlots(); // prime cache
    await service.updateSlot(s.id, { professional: "bob" });
    const { cache, slots } = await service.listSlots();
    expect(cache).toBe("miss");
    expect(slots[0].professional).toBe("bob");
  });

  it("invalidates cache after deleteSlot", async () => {
    const { service } = makeService();
    const s = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await service.listSlots(); // prime cache
    // @ts-expect-error - Auto-fixed by script
    await service.deleteSlot(s.id);
    const { cache, slots } = await service.listSlots();
    expect(cache).toBe("miss");
    expect(slots).toHaveLength(0);
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe("SlotService.deleteSlot", () => {
  it("deletes an existing slot", async () => {
    const { service } = makeService();
    const s = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    // @ts-expect-error - Auto-fixed by script
    await service.deleteSlot(s.id);
    const { slots } = await service.listSlots();
    expect(slots).toHaveLength(0);
  });

  it("throws SlotNotFoundError for unknown id", async () => {
    const { service } = makeService();
    // @ts-expect-error - Auto-fixed by script
    await expect(service.deleteSlot(999)).rejects.toBeInstanceOf(SlotNotFoundError);
  });
});

// ─── findById ─────────────────────────────────────────────────────────────────

describe("SlotService.findById", () => {
  it("returns the slot when found", async () => {
    const { service } = makeService();
    const s = await service.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    const found = await service.findById(s.id);
    expect(found?.id).toBe(s.id);
  });

  it("returns null when not found", async () => {
    const { service } = makeService();
    expect(await service.findById(999)).toBeNull();
  });
});

// ─── Restart durability ───────────────────────────────────────────────────────

describe("restart durability", () => {
  it("data persists in repository across service re-instantiation", async () => {
    // Simulate restart: same repository instance, new service instance
    const repo = new InMemorySlotRepository();
    const svc1 = new SlotService(repo);
    await svc1.createSlot({ professional: "alice", startTime: T1, endTime: T2 });

    // New service instance (simulates process restart with same DB-backed repo)
    const svc2 = new SlotService(repo);
    const { slots } = await svc2.listSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0].professional).toBe("alice");
  });

  it("cache is cold after restart but data is still available", async () => {
    const repo = new InMemorySlotRepository();
    const svc1 = new SlotService(repo, new InMemoryCache({ ttlMs: SLOT_LIST_CACHE_TTL_MS }));
    await svc1.createSlot({ professional: "alice", startTime: T1, endTime: T2 });
    await svc1.listSlots(); // warm cache in svc1

    // New service = cold cache
    const svc2 = new SlotService(repo, new InMemoryCache({ ttlMs: SLOT_LIST_CACHE_TTL_MS }));
    const { slots, cache } = await svc2.listSlots();
    expect(cache).toBe("miss"); // cold cache
    expect(slots).toHaveLength(1);
  });
});

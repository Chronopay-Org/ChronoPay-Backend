/**
 * Comprehensive tests for slot conflict detection.
 *
 * Covers:
 *  - InMemorySlotRepository.hasConflict (all overlap/adjacency cases)
 *  - SlotService.createSlot conflict enforcement
 *  - SlotService.updateSlot conflict enforcement (self-exclusion)
 *  - Concurrency simulation (sequential creates that would race)
 *  - Edge cases: end == start boundary, zero-width slots, different professionals
 */

import {
  InMemorySlotRepository,
  type SlotRecord as RepoSlotRecord,
} from "../modules/slots/slot-repository.js";
import {
  SlotService,
  SlotConflictError,
  SlotValidationError,
} from "../services/slotService.js";

// ─── InMemorySlotRepository.hasConflict ───────────────────────────────────────

describe("InMemorySlotRepository.hasConflict", () => {
  const BASE: RepoSlotRecord = {
    id: "s1",
    professional: "alice",
    startTime: 1000,
    endTime: 2000,
    bookable: true,
  };

  function repo(...extra: RepoSlotRecord[]) {
    return new InMemorySlotRepository([BASE, ...extra]);
  }

  it("returns false when no slots exist for the professional", () => {
    const r = new InMemorySlotRepository([]);
    expect(r.hasConflict("alice", 1000, 2000)).toBe(false);
  });

  it("detects exact overlap", () => {
    expect(repo().hasConflict("alice", 1000, 2000)).toBe(true);
  });

  it("detects partial overlap — new slot starts inside existing", () => {
    expect(repo().hasConflict("alice", 1500, 2500)).toBe(true);
  });

  it("detects partial overlap — new slot ends inside existing", () => {
    expect(repo().hasConflict("alice", 500, 1500)).toBe(true);
  });

  it("detects containment — new slot fully inside existing", () => {
    expect(repo().hasConflict("alice", 1100, 1900)).toBe(true);
  });

  it("detects containment — new slot fully wraps existing", () => {
    expect(repo().hasConflict("alice", 500, 2500)).toBe(true);
  });

  it("allows adjacency — new slot starts exactly when existing ends", () => {
    expect(repo().hasConflict("alice", 2000, 3000)).toBe(false);
  });

  it("allows adjacency — new slot ends exactly when existing starts", () => {
    expect(repo().hasConflict("alice", 0, 1000)).toBe(false);
  });

  it("allows non-overlapping slot before existing", () => {
    expect(repo().hasConflict("alice", 0, 500)).toBe(false);
  });

  it("allows non-overlapping slot after existing", () => {
    expect(repo().hasConflict("alice", 2500, 3000)).toBe(false);
  });

  it("ignores slots belonging to a different professional", () => {
    expect(repo().hasConflict("bob", 1000, 2000)).toBe(false);
  });

  it("excludes the specified slot id (used during updates)", () => {
    // Updating slot s1 to the same range should not conflict with itself.
    expect(repo().hasConflict("alice", 1000, 2000, "s1")).toBe(false);
  });

  it("still detects conflict with other slots when excludeId is set", () => {
    const s2: RepoSlotRecord = {
      id: "s2",
      professional: "alice",
      startTime: 1500,
      endTime: 2500,
      bookable: true,
    };
    // Excluding s1 but s2 still overlaps [1200, 1800]
    expect(repo(s2).hasConflict("alice", 1200, 1800, "s1")).toBe(true);
  });
});

// ─── SlotService conflict detection ──────────────────────────────────────────

describe("SlotService — createSlot conflict detection", () => {
  let service: SlotService;

  beforeEach(() => {
    service = new SlotService();
  });

  it("creates a slot when no conflict exists", () => {
    const slot = service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(slot.id).toBe(1);
  });

  it("throws SlotConflictError on exact overlap", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 }),
    ).toThrow(SlotConflictError);
  });

  it("throws SlotConflictError on partial overlap (new starts inside existing)", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 1500, endTime: 2500 }),
    ).toThrow(SlotConflictError);
  });

  it("throws SlotConflictError on partial overlap (new ends inside existing)", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 500, endTime: 1500 }),
    ).toThrow(SlotConflictError);
  });

  it("throws SlotConflictError when new slot wraps existing", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 500, endTime: 2500 }),
    ).toThrow(SlotConflictError);
  });

  it("allows adjacent slot (new starts exactly when existing ends)", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 2000, endTime: 3000 }),
    ).not.toThrow();
  });

  it("allows adjacent slot (new ends exactly when existing starts)", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 0, endTime: 1000 }),
    ).not.toThrow();
  });

  it("allows overlapping times for a different professional", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "bob", startTime: 1000, endTime: 2000 }),
    ).not.toThrow();
  });

  it("trims professional name before conflict check", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(() =>
      service.createSlot({ professional: "  alice  ", startTime: 1000, endTime: 2000 }),
    ).toThrow(SlotConflictError);
  });

  it("does not create the slot when conflict is detected (state unchanged)", () => {
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    try {
      service.createSlot({ professional: "alice", startTime: 1500, endTime: 2500 });
    } catch {
      // expected
    }
    return service.listSlots().then(({ slots }) => {
      expect(slots).toHaveLength(1);
    });
  });

  it("still throws SlotValidationError for invalid input before conflict check", () => {
    expect(() =>
      service.createSlot({ professional: "alice", startTime: 2000, endTime: 1000 }),
    ).toThrow(SlotValidationError);
  });
});

describe("SlotService — updateSlot conflict detection", () => {
  let service: SlotService;

  beforeEach(() => {
    service = new SlotService();
    service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 });
    service.createSlot({ professional: "alice", startTime: 3000, endTime: 4000 });
  });

  it("allows updating a slot to its own range (no self-conflict)", () => {
    expect(() => service.updateSlot(1, { startTime: 1000, endTime: 2000 })).not.toThrow();
  });

  it("allows shrinking a slot within its own range", () => {
    expect(() => service.updateSlot(1, { startTime: 1100, endTime: 1900 })).not.toThrow();
  });

  it("throws SlotConflictError when update would overlap another slot", () => {
    // Slot 1 is [1000,2000], slot 2 is [3000,4000]. Extending slot 1 into slot 2.
    expect(() => service.updateSlot(1, { endTime: 3500 })).toThrow(SlotConflictError);
  });

  it("allows moving slot to a non-conflicting range", () => {
    expect(() => service.updateSlot(1, { startTime: 2000, endTime: 2500 })).not.toThrow();
  });
});

// ─── Concurrency simulation ───────────────────────────────────────────────────

describe("SlotService — concurrency simulation", () => {
  it("only one of two concurrent creates for the same slot wins", async () => {
    const service = new SlotService();

    // Simulate two concurrent requests that both pass the initial check
    // before either commits. In the in-memory implementation the second
    // synchronous call will see the first slot already inserted.
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 }),
      ),
      Promise.resolve().then(() =>
        service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 }),
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotConflictError);
  });

  it("allows two concurrent creates for different professionals", async () => {
    const service = new SlotService();

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 }),
      ),
      Promise.resolve().then(() =>
        service.createSlot({ professional: "bob", startTime: 1000, endTime: 2000 }),
      ),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("allows two concurrent creates for non-overlapping times", async () => {
    const service = new SlotService();

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        service.createSlot({ professional: "alice", startTime: 1000, endTime: 2000 }),
      ),
      Promise.resolve().then(() =>
        service.createSlot({ professional: "alice", startTime: 2000, endTime: 3000 }),
      ),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

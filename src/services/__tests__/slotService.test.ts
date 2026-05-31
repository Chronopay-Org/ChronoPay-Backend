import { jest } from "@jest/globals";
import {
  SlotService,
  SlotValidationError,
  SlotNotFoundError,
  SlotConflictError,
  SlotInput,
} from "../slotService.js";
import { InMemoryCache } from "../../cache/inMemoryCache.js";

describe("SlotService", () => {
  let mockClock: () => Date;
  let cache: InMemoryCache<any>;
  let slotService: SlotService;

  beforeEach(() => {
    // Set up a mock clock returning a fixed date
    const fixedTime = new Date("2026-05-27T10:00:00.000Z");
    mockClock = jest.fn(() => fixedTime);
    cache = new InMemoryCache<any>({ ttlMs: 60_000 });
    slotService = new SlotService(cache, mockClock);
  });

  describe("Constructor & Initialization", () => {
    it("should initialize without arguments, defaulting to no cache and real clock", () => {
      const service = new SlotService();
      expect(service).toBeDefined();
    });

    it("should initialize with only a clock function", () => {
      const customClock = () => new Date();
      const service = new SlotService(customClock);
      expect(service).toBeDefined();
    });

    it("should initialize with only a cache instance", () => {
      const service = new SlotService(cache);
      expect(service).toBeDefined();
    });
  });

  describe("Validation", () => {
    it("should throw SlotValidationError if professional is empty or not a string", () => {
      const invalidInputs: any[] = [
        { professional: "", startTime: 10, endTime: 20 },
        { professional: "   ", startTime: 10, endTime: 20 },
        { professional: null, startTime: 10, endTime: 20 },
        { professional: 123, startTime: 10, endTime: 20 },
      ];

      for (const input of invalidInputs) {
        expect(() => slotService.createSlot(input)).toThrow(SlotValidationError);
        expect(() => slotService.createSlot(input)).toThrow("professional must be a non-empty string");
      }
    });

    it("should throw SlotValidationError if startTime or endTime are not finite numbers", () => {
      const invalidInputs: any[] = [
        { professional: "Dr. Smith", startTime: NaN, endTime: 20 },
        { professional: "Dr. Smith", startTime: 10, endTime: Infinity },
        { professional: "Dr. Smith", startTime: -Infinity, endTime: 20 },
        { professional: "Dr. Smith", startTime: "10", endTime: 20 },
      ];

      for (const input of invalidInputs) {
        expect(() => slotService.createSlot(input)).toThrow(SlotValidationError);
        expect(() => slotService.createSlot(input)).toThrow("startTime and endTime must be finite numbers");
      }
    });

    it("should throw SlotValidationError if endTime <= startTime", () => {
      const invalidInputs = [
        { professional: "Dr. Smith", startTime: 20, endTime: 10 },
        { professional: "Dr. Smith", startTime: 20, endTime: 20 },
      ];

      for (const input of invalidInputs) {
        expect(() => slotService.createSlot(input)).toThrow(SlotValidationError);
        expect(() => slotService.createSlot(input)).toThrow("endTime must be greater than startTime");
      }
    });
  });

  describe("Conflict Detection (hasConflict)", () => {
    beforeEach(() => {
      // Create a baseline slot: Dr. Smith [1000, 2000]
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
    });

    it("should not detect conflict if slot is for a different professional", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Jones", 1500, 2500)).toBe(false);
    });

    it("should detect conflict when new slot is fully inside an existing slot", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 1200, 1800)).toBe(true);
    });

    it("should detect conflict when new slot completely envelops an existing slot", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 800, 2200)).toBe(true);
    });

    it("should detect conflict when new slot overlaps the start of the existing slot", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 800, 1500)).toBe(true);
    });

    it("should detect conflict when new slot overlaps the end of the existing slot", () => {
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 1500, 2500)).toBe(true);
    });

    it("should not detect conflict for adjacent slots (end == start)", () => {
      // New slot ends exactly when existing starts
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 500, 1000)).toBe(false);
      // New slot starts exactly when existing ends
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 2000, 3000)).toBe(false);
    });

    it("should detect conflict when overlapping by exactly 1ms", () => {
      // New slot overlaps start by 1ms
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 500, 1001)).toBe(true);
      // New slot overlaps end by 1ms
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 1999, 3000)).toBe(true);
    });

    it("should respect excludeId parameter to ignore a specific slot", () => {
      // Exclude the only existing slot (which has ID 1)
      // @ts-expect-error - Auto-fixed by script
      expect(slotService.hasConflict("Dr. Smith", 1200, 1800, 1)).toBe(false);
    });
  });

  describe("createSlot", () => {
    it("should successfully create a valid slot", () => {
      const input: SlotInput = {
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      };

      const result = slotService.createSlot(input);

      expect(result).toEqual({
        id: 1,
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
        createdAt: "2026-05-27T10:00:00.000Z",
        updatedAt: "2026-05-27T10:00:00.000Z",
      });
    });

    it("should trim the professional name", () => {
      const input: SlotInput = {
        professional: "  Dr. Smith   ",
        startTime: 1000,
        endTime: 2000,
      };

      const result = slotService.createSlot(input);
      expect(result.professional).toBe("Dr. Smith");
    });

    it("should throw SlotConflictError if a conflict exists", () => {
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });

      expect(() => {
        slotService.createSlot({ professional: "Dr. Smith", startTime: 1500, endTime: 2500 });
      }).toThrow(SlotConflictError);
    });

    it("should invalidate the cache when a slot is created", () => {
      const invalidateSpy = jest.spyOn(cache, "invalidate");
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });

      expect(invalidateSpy).toHaveBeenCalledWith("slots:list:all");
    });
  });

  describe("updateSlot", () => {
    let createdSlot: any;

    beforeEach(() => {
      createdSlot = slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
    });

    it("should successfully update startTime and/or endTime of an existing slot", () => {
      // Modify clock return value to simulate time elapsed
      (mockClock as any).mockReturnValue(new Date("2026-05-27T10:05:00.000Z"));

      const result = slotService.updateSlot(createdSlot.id, { startTime: 1200, endTime: 2200 });

      expect(result).toEqual({
        id: createdSlot.id,
        professional: "Dr. Smith",
        startTime: 1200,
        endTime: 2200,
        createdAt: "2026-05-27T10:00:00.000Z", // Unchanged
        updatedAt: "2026-05-27T10:05:00.000Z", // Updated
      });
    });

    it("should successfully update professional name of an existing slot", () => {
      const result = slotService.updateSlot(createdSlot.id, { professional: "Dr. Smith Jr." });
      expect(result.professional).toBe("Dr. Smith Jr.");
    });

    it("should throw SlotNotFoundError if the slot does not exist", () => {
      expect(() => {
        slotService.updateSlot(999, { startTime: 1200 });
      }).toThrow(SlotNotFoundError);
      expect(() => {
        slotService.updateSlot(999, { startTime: 1200 });
      }).toThrow("Slot 999 was not found");
    });

    it("should throw SlotValidationError if patch is null, not an object, or empty", () => {
      expect(() => slotService.updateSlot(createdSlot.id, null as any)).toThrow(SlotValidationError);
      expect(() => slotService.updateSlot(createdSlot.id, [] as any)).toThrow(SlotValidationError);
      expect(() => slotService.updateSlot(createdSlot.id, {})).toThrow(SlotValidationError);
    });

    it("should throw SlotValidationError if professional is not a string in patch", () => {
      expect(() => slotService.updateSlot(createdSlot.id, { professional: 123 as any })).toThrow(SlotValidationError);
    });

    it("should throw SlotValidationError if startTime or endTime in patch are not finite numbers", () => {
      expect(() => slotService.updateSlot(createdSlot.id, { startTime: NaN })).toThrow(SlotValidationError);
      expect(() => slotService.updateSlot(createdSlot.id, { endTime: Infinity })).toThrow(SlotValidationError);
    });

    it("should throw SlotValidationError if updated range makes endTime <= startTime", () => {
      expect(() => slotService.updateSlot(createdSlot.id, { startTime: 2500 })).toThrow(SlotValidationError);
      expect(() => slotService.updateSlot(createdSlot.id, { endTime: 500 })).toThrow(SlotValidationError);
    });

    it("should throw SlotConflictError if update conflicts with another slot", () => {
      // Create another slot
      slotService.createSlot({ professional: "Dr. Smith", startTime: 3000, endTime: 4000 });

      // Try updating first slot to overlap with second slot
      expect(() => {
        slotService.updateSlot(createdSlot.id, { endTime: 3500 });
      }).toThrow(SlotConflictError);
    });

    it("should NOT throw conflict when slot is updated within its own boundaries (excludeId check)", () => {
      // Shifting slot slightly, still overlaps itself
      const result = slotService.updateSlot(createdSlot.id, { startTime: 1100, endTime: 1900 });
      expect(result.startTime).toBe(1100);
      expect(result.endTime).toBe(1900);
    });

    it("should invalidate the cache when a slot is updated", () => {
      const invalidateSpy = jest.spyOn(cache, "invalidate");
      slotService.updateSlot(createdSlot.id, { startTime: 1200 });

      expect(invalidateSpy).toHaveBeenCalledWith("slots:list:all");
    });
  });

  describe("listSlots", () => {
    it("should list slots from cache or repository depending on cache presence", async () => {
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });

      // First list call: cache miss
      const res1 = await slotService.listSlots();
      expect(res1.slots.length).toBe(1);
      expect(res1.cache).toBe("miss");

      // Second list call: cache hit
      const res2 = await slotService.listSlots();
      expect(res2.slots.length).toBe(1);
      expect(res2.cache).toBe("hit");
    });

    it("should return miss when cache is disabled", async () => {
      const noCacheService = new SlotService(mockClock);
      noCacheService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });

      const res1 = await noCacheService.listSlots();
      expect(res1.cache).toBe("miss");

      const res2 = await noCacheService.listSlots();
      expect(res2.cache).toBe("miss");
    });
  });

  describe("reset", () => {
    it("should clear the slots array, reset the nextId, and clear the cache", async () => {
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
      await slotService.listSlots(); // populate cache

      const clearSpy = jest.spyOn(cache, "clear");
      slotService.reset();

      expect(clearSpy).toHaveBeenCalled();
      const res = await slotService.listSlots();
      expect(res.slots).toEqual([]);
      expect(res.cache).toBe("miss");

      // Create new slot, ID should be reset to 1
      const newSlot = slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
      expect(newSlot.id).toBe(1);
    });
  });

  describe("Traced wrappers (createSlotTraced, updateSlotTraced, listSlotsTraced)", () => {
    it("should call createSlot inside withSpan", async () => {
      const input = { professional: "Dr. Smith", startTime: 1000, endTime: 2000 };
      // @ts-expect-error - Auto-fixed by script
      const result = await slotService.createSlotTraced(input);
      expect(result.id).toBe(1);
      expect(result.professional).toBe("Dr. Smith");
    });

    it("should call updateSlot inside withSpan", async () => {
      const slot = slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
      // @ts-expect-error - Auto-fixed by script
      const result = await slotService.updateSlotTraced(slot.id, { startTime: 1200 });
      expect(result.startTime).toBe(1200);
    });

    it("should call listSlots inside withSpan", async () => {
      slotService.createSlot({ professional: "Dr. Smith", startTime: 1000, endTime: 2000 });
      // @ts-expect-error - Auto-fixed by script
      const result = await slotService.listSlotsTraced();
      expect(result.slots.length).toBe(1);
    });
  });
});

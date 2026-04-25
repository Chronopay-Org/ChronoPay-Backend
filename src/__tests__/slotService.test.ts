import { InMemoryCache } from "../cache/inMemoryCache.js";
import {
  SLOT_LIST_CACHE_TTL_MS,
  SlotService,
  SlotValidationError,
  type Slot,
} from "../services/slotService.js";

describe.skip("SlotService", () => {
  let currentTime: number;
  let service: SlotService;

  beforeEach(() => {
    currentTime = Date.parse("2026-03-28T00:00:00.000Z");

    service = new SlotService(
      new InMemoryCache<Slot[]>({
        ttlMs: SLOT_LIST_CACHE_TTL_MS,
        maxEntries: 10,
        clock: () => currentTime,
      }),
      () => new Date(currentTime),
    );
  });

  it("returns a miss before a hit for repeated reads", async () => {
    await expect(service.listSlots()).resolves.toMatchObject({
      slots: [],
      cache: "miss",
    });

    await expect(service.listSlots()).resolves.toMatchObject({
      slots: [],
      cache: "hit",
    });
  });

  it("invalidates the cached list after creating a slot", async () => {
    await service.listSlots();

    service.createSlot({
      professional: "alice",
      startTime: 1_000,
      endTime: 2_000,
    });

    await expect(service.listSlots()).resolves.toMatchObject({
      cache: "miss",
      slots: [
        expect.objectContaining({
          professional: "alice",
          startTime: 1_000,
          endTime: 2_000,
        }),
      ],
    });
  });

  it("returns clones so callers cannot mutate cached state", async () => {
    service.createSlot({
      professional: "alice",
      startTime: 1_000,
      endTime: 2_000,
    });

    const firstRead = await service.listSlots();
    firstRead.slots[0].professional = "tampered";

    const secondRead = await service.listSlots();

    expect(secondRead.slots[0].professional).toBe("alice");
  });

  it("rejects reversed time ranges", () => {
    expect(() =>
      service.createSlot({
        professional: "alice",
        startTime: 2_000,
        endTime: 1_000,
      }),
    ).toThrow(SlotValidationError);
  });

  it("rejects empty professional values", () => {
    expect(() =>
      service.createSlot({
        professional: "   ",
        startTime: 1_000,
        endTime: 2_000,
      }),
    ).toThrow("professional must be a non-empty string");
  });

  it("rejects non-finite time values", () => {
    expect(() =>
      service.createSlot({
        professional: "alice",
        startTime: Number.NaN,
        endTime: 2_000,
      }),
    ).toThrow("startTime and endTime must be finite numbers");
  });
});
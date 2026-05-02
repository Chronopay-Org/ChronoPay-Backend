import { PaginatedSlots, Slot } from "../types.js";
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";
import { InMemoryCache } from "../cache/inMemoryCache.js";

// ─── Domain errors ────────────────────────────────────────────────────────────

export class SlotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotValidationError";
  }
}

export class SlotNotFoundError extends Error {
  constructor(id: number) {
    super(`Slot ${id} was not found`);
    this.name = "SlotNotFoundError";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlotData {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateSlotInput = Omit<SlotData, "id" | "createdAt" | "updatedAt">;
export type UpdateSlotInput = Partial<Pick<SlotData, "professional" | "startTime" | "endTime">>;

export type ListSlotsResult = { slots: SlotData[]; cache: "hit" | "miss" };

export const SLOT_LIST_CACHE_TTL_MS = 60_000;
const SLOT_LIST_CACHE_KEY = "slots:list:all";

// ─── SlotService class ────────────────────────────────────────────────────────

export class SlotService {
  private readonly store: SlotData[] = [];
  private nextId = 1;
  private readonly cache: InMemoryCache<SlotData[]>;
  private readonly clock: () => Date;

  constructor(
    cache: InMemoryCache<SlotData[]> = new InMemoryCache<SlotData[]>({ ttlMs: SLOT_LIST_CACHE_TTL_MS }),
    clock: () => Date = () => new Date(),
  ) {
    this.cache = cache;
    this.clock = clock;
  }

  createSlot(input: CreateSlotInput): SlotData {
    this._validateSlotInput(input);

    const now = this.clock();
    const slot: SlotData = {
      id: this.nextId++,
      professional: input.professional.trim(),
      startTime: input.startTime,
      endTime: input.endTime,
      createdAt: now,
      updatedAt: now,
    };

    this.store.push(slot);
    this.cache.invalidate(SLOT_LIST_CACHE_KEY);
    return { ...slot };
  }

  async listSlots(): Promise<ListSlotsResult> {
    const result = await this.cache.getOrLoad(SLOT_LIST_CACHE_KEY, () =>
      this.store.map((s) => ({ ...s })),
    );

    return {
      slots: result.value.map((s) => ({ ...s })),
      cache: result.source === "cache" ? "hit" : "miss",
    };
  }

  updateSlot(id: number, updates: UpdateSlotInput): SlotData {
    if (updates === null || typeof updates !== "object") {
      throw new SlotValidationError("update payload must be an object");
    }

    if ("professional" in updates && typeof updates.professional !== "string") {
      throw new SlotValidationError("professional must be a string");
    }

    const hasTime = "startTime" in updates || "endTime" in updates;
    if (hasTime) {
      const st = updates.startTime;
      const et = updates.endTime;
      if ((st !== undefined && !Number.isFinite(st)) || (et !== undefined && !Number.isFinite(et))) {
        throw new SlotValidationError("startTime and endTime must be finite numbers");
      }
    }

    const idx = this.store.findIndex((s) => s.id === id);
    if (idx === -1) throw new SlotNotFoundError(id);

    const existing = this.store[idx];
    const merged: SlotData = {
      ...existing,
      ...updates,
      professional:
        updates.professional !== undefined
          ? updates.professional.trim()
          : existing.professional,
      updatedAt: this.clock(),
    };

    const effectiveStart = merged.startTime;
    const effectiveEnd = merged.endTime;
    if (effectiveEnd <= effectiveStart) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }

    this.store[idx] = merged;
    this.cache.invalidate(SLOT_LIST_CACHE_KEY);
    return { ...merged };
  }

  reset(): void {
    this.store.length = 0;
    this.nextId = 1;
    this.cache.clear();
  }

  private _validateSlotInput(input: CreateSlotInput): void {
    if (typeof input.professional !== "string" || input.professional.trim() === "") {
      throw new SlotValidationError("professional must be a non-empty string");
    }

    if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime)) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }

    if (input.endTime <= input.startTime) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }
  }
}

/** Shared singleton used by route handlers. */
export const slotService = new SlotService();

const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface SlotRepositoryInterface {
  getSlotsCount: () => Promise<number>;
  getSlotsPage: (offset: number, limit: number) => Promise<Slot[]>;
}

function sanitizeSlot(slot: Slot): Slot {
  const { _internalNote, ...publicSlot } = slot;
  return publicSlot;
}

export const listSlots = async (
  options: PaginationOptions,
  repository: SlotRepositoryInterface = { getSlotsCount, getSlotsPage }
): Promise<PaginatedSlots> => {
  const page = options.page ?? DEFAULT_PAGE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (!Number.isInteger(page) || page < 1) {
    throw new Error("Invalid page");
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Invalid limit");
  }

  if (limit > MAX_LIMIT) {
    throw new Error("Limit exceeds maximum allowed value");
  }

  const total = await repository.getSlotsCount();
  const offset = (page - 1) * limit;

  if (offset >= total && total > 0) {
    // requested page beyond number of items results empty data, keep page
    return {
      data: [],
      page,
      limit,
      total,
    };
  }

  const rawSlots = await repository.getSlotsPage(offset, limit);
  const data = rawSlots.map(sanitizeSlot);

  return {
    data,
    page,
    limit,
    total,
  };
};

export const listSlotsWithFailure = async (options: PaginationOptions): Promise<PaginatedSlots> => {
  // wrapper for simulating DB failures in tests (not used in production)
  return listSlots(options);
};

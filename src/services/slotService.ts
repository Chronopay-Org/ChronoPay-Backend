import { InMemoryCache } from "../cache/inMemoryCache.js";
import { PaginatedSlots, Slot as PaginatedSlot } from "../types.js";
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";

const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface SlotRepositoryInterface {
  getSlotsCount: () => Promise<number>;
  getSlotsPage: (offset: number, limit: number) => Promise<PaginatedSlot[]>;
}

function sanitizeSlot(slot: PaginatedSlot): PaginatedSlot {
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

export const SLOT_LIST_CACHE_TTL_MS = 60_000;
const SLOT_LIST_CACHE_KEY = "slots:list:all";

export interface Slot {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt: string;
  updatedAt: string;
}

interface CreateSlotInput {
  professional: string;
  startTime: number;
  endTime: number;
}

interface UpdateSlotInput {
  professional?: string;
  startTime?: number;
  endTime?: number;
}

export class SlotValidationError extends Error {}
export class SlotNotFoundError extends Error {}

export class SlotService {
  private readonly slots: Slot[] = [];
  private nextId = 1;
  private readonly cache: InMemoryCache<Slot[]>;
  private readonly now: () => Date;
  private readonly includeCacheMetadata: boolean;

  constructor(
    cacheOrNow: InMemoryCache<Slot[]> | (() => Date) = () => new Date(),
    maybeNow?: () => Date,
  ) {
    if (cacheOrNow instanceof InMemoryCache) {
      this.cache = cacheOrNow;
      this.now = maybeNow ?? (() => new Date());
      this.includeCacheMetadata = true;
    } else {
      this.cache = new InMemoryCache<Slot[]>({ ttlMs: SLOT_LIST_CACHE_TTL_MS });
      this.now = cacheOrNow;
      this.includeCacheMetadata = false;
    }
  }

  private cloneSlots(slots: Slot[]): Slot[] {
    return slots.map((slot) => ({ ...slot }));
  }

  private validateTimes(startTime: number, endTime: number): void {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }
    if (endTime <= startTime) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }
  }

  createSlot(input: CreateSlotInput): Slot {
    if (typeof input.professional !== "string" || input.professional.trim().length === 0) {
      throw new SlotValidationError("professional must be a non-empty string");
    }
    this.validateTimes(input.startTime, input.endTime);

    const timestamp = this.now().toISOString();
    const slot: Slot = {
      id: this.nextId++,
      professional: input.professional.trim(),
      startTime: input.startTime,
      endTime: input.endTime,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.slots.push(slot);
    this.cache.invalidateByPrefix("slots:list:");
    return { ...slot };
  }

  updateSlot(slotId: number, updates: UpdateSlotInput): Slot {
    if (!updates || typeof updates !== "object") {
      throw new SlotValidationError("update payload must include at least one field");
    }
    const slot = this.slots.find((entry) => entry.id === slotId);
    if (!slot) {
      throw new SlotNotFoundError(`Slot ${slotId} was not found`);
    }

    if (
      typeof updates.professional === "undefined" &&
      typeof updates.startTime === "undefined" &&
      typeof updates.endTime === "undefined"
    ) {
      throw new SlotValidationError("update payload must include at least one field");
    }

    if (typeof updates.professional !== "undefined") {
      if (typeof updates.professional !== "string") {
        throw new SlotValidationError("professional must be a string");
      }
      const trimmed = updates.professional.trim();
      if (!trimmed) {
        throw new SlotValidationError("professional must be a non-empty string");
      }
      slot.professional = trimmed;
    }

    const startTime = updates.startTime ?? slot.startTime;
    const endTime = updates.endTime ?? slot.endTime;
    this.validateTimes(startTime, endTime);
    slot.startTime = startTime;
    slot.endTime = endTime;
    slot.updatedAt = this.now().toISOString();
    this.cache.invalidateByPrefix("slots:list:");
    return { ...slot };
  }

  listSlots(): Slot[] | { slots: Slot[]; cache: "hit" | "miss" } {
    const cached = this.cache.get(SLOT_LIST_CACHE_KEY);
    if (cached) {
      const slots = this.cloneSlots(cached);
      return this.includeCacheMetadata ? { slots, cache: "hit" as const } : slots;
    }
    const fresh = this.cloneSlots(this.slots);
    this.cache.set(SLOT_LIST_CACHE_KEY, fresh);
    return this.includeCacheMetadata ? { slots: fresh, cache: "miss" as const } : fresh;
  }

  reset(): void {
    this.slots.length = 0;
    this.nextId = 1;
    this.cache.clear();
  }
}

export const slotService = new SlotService();

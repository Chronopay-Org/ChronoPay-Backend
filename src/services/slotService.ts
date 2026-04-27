import { InMemoryCache } from "../cache/inMemoryCache.js";
import { PaginatedSlots, Slot as PaginatedSlot } from "../types.js";
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";
import { InMemoryCache } from "../cache/inMemoryCache.js";

// Internal Slot type for SlotService
export interface Slot {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt?: string;
  _internalNote?: string;
}

const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

export const SLOT_LIST_CACHE_TTL_MS = 60_000;
const SLOT_LIST_CACHE_KEY = "slots:list:all";

// ─── Errors ───────────────────────────────────────────────────────────────────

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

export class SlotConflictError extends Error {
  constructor() {
    super("Slot overlaps with an existing reservation for this professional");
    this.name = "SlotConflictError";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlotInput {
  professional: string;
  startTime: number;
  endTime: number;
}

export interface SlotRecord {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt: string;
  updatedAt: string;
}

export type { SlotRecord as Slot };

// ─── SlotService ──────────────────────────────────────────────────────────────

export class SlotService {
  private slots: SlotRecord[] = [];
  private nextId = 1;
  private readonly cache: InMemoryCache<SlotRecord[]> | null;
  private readonly clock: () => Date;

  /**
   * @param cacheOrClock - Either an InMemoryCache instance (with optional clock
   *   as second arg), or a clock function directly (cache disabled).
   */
  constructor(
    cacheOrClock?: InMemoryCache<SlotRecord[]> | (() => Date),
    clock?: () => Date,
  ) {
    if (typeof cacheOrClock === "function") {
      this.cache = null;
      this.clock = cacheOrClock;
    } else {
      this.cache = cacheOrClock ?? null;
      this.clock = clock ?? (() => new Date());
    }
  }

  // ── Validation helpers ──────────────────────────────────────────────────────

  private static validateInput(input: SlotInput): void {
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

  // ── Conflict detection ──────────────────────────────────────────────────────

  /**
   * Returns true if any existing slot for the same professional overlaps the
   * given half-open interval [startTime, endTime).
   * Adjacency (end == start of another) is NOT a conflict.
   */
  hasConflict(
    professional: string,
    startTime: number,
    endTime: number,
    excludeId?: number,
  ): boolean {
    return this.slots.some(
      (s) =>
        s.professional === professional &&
        s.id !== excludeId &&
        s.startTime < endTime &&
        s.endTime > startTime,
    );
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  createSlot(input: SlotInput): SlotRecord {
    SlotService.validateInput(input);

    const professional = input.professional.trim();

    if (this.hasConflict(professional, input.startTime, input.endTime)) {
      throw new SlotConflictError();
    }

    const now = this.clock().toISOString();
    const slot: SlotRecord = {
      id: this.nextId++,
      professional,
      startTime: input.startTime,
      endTime: input.endTime,
      createdAt: now,
      updatedAt: now,
    };

    this.slots.push(slot);
    this.cache?.invalidate(SLOT_LIST_CACHE_KEY);

    return { ...slot };
  }

  updateSlot(
    id: number,
    patch: Partial<Pick<SlotInput, "professional" | "startTime" | "endTime">>,
  ): SlotRecord {
    if (patch === null || typeof patch !== "object") {
      throw new SlotValidationError("update payload must be an object");
    }

    if (Object.keys(patch).length === 0) {
      throw new SlotValidationError("update payload must include at least one field");
    }

    const index = this.slots.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new SlotNotFoundError(id);
    }

    const existing = this.slots[index];

    if ("professional" in patch) {
      if (typeof patch.professional !== "string") {
        throw new SlotValidationError("professional must be a string");
      }
    }

    if (
      ("startTime" in patch && !Number.isFinite(patch.startTime)) ||
      ("endTime" in patch && !Number.isFinite(patch.endTime))
    ) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }

    const professional = (patch.professional?.trim() ?? existing.professional);
    const startTime = patch.startTime ?? existing.startTime;
    const endTime = patch.endTime ?? existing.endTime;

    if (endTime <= startTime) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }

    if (this.hasConflict(professional, startTime, endTime, id)) {
      throw new SlotConflictError();
    }

    const updated: SlotRecord = {
      ...existing,
      professional,
      startTime,
      endTime,
      updatedAt: this.clock().toISOString(),
    };

    this.slots[index] = updated;
    this.cache?.invalidate(SLOT_LIST_CACHE_KEY);

    return { ...updated };
  }

  async listSlots(): Promise<{ slots: SlotRecord[]; cache: "hit" | "miss" }> {
    if (this.cache) {
      const result = await this.cache.getOrLoad(SLOT_LIST_CACHE_KEY, () =>
        this.slots.map((s) => ({ ...s })),
      );
      return {
        slots: result.value.map((s) => ({ ...s })),
        cache: result.source === "cache" ? "hit" : "miss",
      };
    }

    return { slots: this.slots.map((s) => ({ ...s })), cache: "miss" };
  }

  reset(): void {
    this.slots = [];
    this.nextId = 1;
    this.cache?.clear();
  }
}

/** Singleton used by route handlers. */
export const slotService = new SlotService(
  new InMemoryCache<SlotRecord[]>({ ttlMs: SLOT_LIST_CACHE_TTL_MS }),
);

// ─── Legacy functional API (kept for backward compatibility) ──────────────────

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

  const start = Date.now();
  try {
    const total = await repository.getSlotsCount();
    const offset = (page - 1) * limit;

  if (offset >= total && total > 0) {
    return {
      data: [],
      page,
      limit,
      total,
    };
  }

    recordListLatency(Date.now() - start);
    recordSlotOperation("list", "success");

    return { data, page, limit, total };
  } catch (err) {
    recordListLatency(Date.now() - start);
    recordSlotOperation("list", "error");
    throw err;
  }
};

export const listSlotsWithFailure = async (options: PaginationOptions): Promise<PaginatedSlots> => {
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

import { PaginatedSlots, Slot } from "../types.js";
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";
import { InMemoryCache } from "../cache/inMemoryCache.js";

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
  return listSlots(options);
};

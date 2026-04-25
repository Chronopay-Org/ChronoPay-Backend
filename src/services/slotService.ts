import { PaginatedSlots, Slot } from "../types.js";
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

// ─── Class-based SlotService API (used by slotService.test.ts and slot-service.test.ts) ───

export const SLOT_LIST_CACHE_TTL_MS = 60_000;

export class SlotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotValidationError";
  }
}

export class SlotNotFoundError extends Error {
  constructor(message = "Slot not found") {
    super(message);
    this.name = "SlotNotFoundError";
  }
}

export interface SlotRecord {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt: Date;
}

export interface CreateSlotInput {
  professional: string;
  startTime: number;
  endTime: number;
}

export interface UpdateSlotInput {
  professional?: string;
  startTime?: number;
  endTime?: number;
}

interface SlotCache {
  get(key: string): SlotRecord[] | undefined;
  set(key: string, value: SlotRecord[]): void;
  invalidate(key: string): boolean;
}

const SLOTS_CACHE_KEY = "slots:all";

export class SlotService {
  private slots: SlotRecord[] = [];
  private nextId = 1;
  private readonly cache: SlotCache | null;
  private readonly clock: () => Date;

  constructor(
    cacheOrClock?: SlotCache | (() => Date),
    clock?: () => Date,
  ) {
    if (typeof cacheOrClock === "function") {
      this.cache = null;
      this.clock = cacheOrClock;
    } else if (cacheOrClock && typeof cacheOrClock === "object") {
      this.cache = cacheOrClock;
      this.clock = clock ?? (() => new Date());
    } else {
      this.cache = null;
      this.clock = () => new Date();
    }
  }

  async listSlots(): Promise<{ slots: SlotRecord[]; cache: "hit" | "miss" }>;
  listSlots(): SlotRecord[];
  listSlots(): Promise<{ slots: SlotRecord[]; cache: "hit" | "miss" }> | SlotRecord[] {
    if (this.cache) {
      const cached = this.cache.get(SLOTS_CACHE_KEY);
      if (cached !== undefined) {
        return Promise.resolve({ slots: cached.map((s) => ({ ...s })), cache: "hit" });
      }
      const fresh = this.slots.map((s) => ({ ...s }));
      this.cache.set(SLOTS_CACHE_KEY, fresh);
      return Promise.resolve({ slots: fresh.map((s) => ({ ...s })), cache: "miss" });
    }
    return this.slots.map((s) => ({ ...s }));
  }

  createSlot(input: CreateSlotInput): SlotRecord {
    if (typeof input.professional !== "string" || input.professional.trim().length === 0) {
      throw new SlotValidationError("professional must be a non-empty string");
    }
    if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime)) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }
    if (input.startTime >= input.endTime) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }

    const slot: SlotRecord = {
      id: this.nextId++,
      professional: input.professional.trim(),
      startTime: input.startTime,
      endTime: input.endTime,
      createdAt: this.clock(),
    };

    this.slots.push(slot);
    this.cache?.invalidate(SLOTS_CACHE_KEY);
    return { ...slot };
  }

  updateSlot(id: number, input: UpdateSlotInput): SlotRecord {
    if (input === null || typeof input !== "object") {
      throw new SlotValidationError("Update payload must be an object");
    }

    const idx = this.slots.findIndex((s) => s.id === id);
    if (idx === -1) throw new SlotNotFoundError();

    const slot = this.slots[idx];

    if ("professional" in input) {
      if (typeof input.professional !== "string") {
        throw new SlotValidationError("professional must be a string");
      }
      if (input.professional.trim().length === 0) {
        throw new SlotValidationError("professional must be a non-empty string");
      }
    }

    const newStart = input.startTime ?? slot.startTime;
    const newEnd = input.endTime ?? slot.endTime;

    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }
    if (newStart >= newEnd) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }

    const updated: SlotRecord = {
      ...slot,
      ...(input.professional !== undefined ? { professional: input.professional.trim() } : {}),
      startTime: newStart,
      endTime: newEnd,
    };

    this.slots[idx] = updated;
    this.cache?.invalidate(SLOTS_CACHE_KEY);
    return { ...updated };
  }

  reset(): void {
    this.slots = [];
    this.nextId = 1;
    this.cache?.invalidate(SLOTS_CACHE_KEY);
  }
}

// Singleton instance used by route handlers and tests
export const slotService = new SlotService();

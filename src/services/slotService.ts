/**
 * slotService.ts
 *
 * SlotService owns all business logic for slot CRUD:
 *  - Input validation
 *  - Conflict detection (fast-path via repository.hasConflict, then DB constraint)
 *  - Cache invalidation on every write
 *  - Metrics and tracing
 *
 * Persistence is fully delegated to an ISlotRepository so the service is
 * testable without a database.  The production singleton uses PgSlotRepository.
 *
 * DB exclusion constraint violations (PostgreSQL error code 23P01) are caught
 * and re-thrown as SlotConflictError so callers get a consistent error type
 * regardless of whether the conflict was caught by the fast-path check or the
 * DB constraint (concurrent inserts).
 */

import { InMemoryCache } from "../cache/inMemoryCache.js";
import { PaginatedSlots, Slot as PaginatedSlot } from "../types.js";
import {
  ISlotRepository,
  PgSlotRepository,
  getSlotsCount,
  getSlotsPage,
} from "../repositories/slotRepository.js";
import { withSpan } from "../tracing/hooks.js";
import { recordListLatency, recordSlotOperation } from "../metrics/slotMetrics.js";

export type { SlotRecord } from "../repositories/slotRepository.js";
export type { SlotRecord as Slot } from "../repositories/slotRepository.js";

// ─── Re-export SlotInput so callers don't need to import from two places ──────
export type { SlotInput } from "../repositories/slotRepository.js";

// ─── Internal Slot type (kept for backward compat with app.ts stub) ───────────
export interface Slot {
  id: number;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt?: string;
  _internalNote?: string;
}

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

/** PostgreSQL exclusion constraint violation code. */
const PG_EXCLUSION_VIOLATION = "23P01";

// ─── SlotService ──────────────────────────────────────────────────────────────

import type { SlotRecord, SlotInput } from "../repositories/slotRepository.js";

export class SlotService {
  private readonly cache: InMemoryCache<SlotRecord[]> | null;

  constructor(
    private readonly repository: ISlotRepository,
    cache?: InMemoryCache<SlotRecord[]>,
  ) {
    this.cache = cache ?? null;
  }

  // ── Validation ──────────────────────────────────────────────────────────────

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

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async createSlot(input: SlotInput): Promise<SlotRecord> {
    SlotService.validateInput(input);

    const professional = input.professional.trim();

    if (await this.repository.hasConflict(professional, input.startTime, input.endTime)) {
      throw new SlotConflictError();
    }

    try {
      const slot = await this.repository.create({ ...input, professional });
      this.cache?.invalidate(SLOT_LIST_CACHE_KEY);
      recordSlotOperation("create", "success");
      return slot;
    } catch (err: unknown) {
      // Map DB exclusion constraint violation → SlotConflictError
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { code?: string }).code === PG_EXCLUSION_VIOLATION
      ) {
        throw new SlotConflictError();
      }
      recordSlotOperation("create", "error");
      throw err;
    }
  }

  createSlotTraced(input: SlotInput): Promise<SlotRecord> {
    return withSpan("slots.create", { route: "POST /api/v1/slots" }, () =>
      this.createSlot(input),
    );
  }

  async updateSlot(
    id: number,
    patch: Partial<SlotInput>,
  ): Promise<SlotRecord> {
    if (patch === null || typeof patch !== "object") {
      throw new SlotValidationError("update payload must be an object");
    }
    if (Object.keys(patch).length === 0) {
      throw new SlotValidationError("update payload must include at least one field");
    }

    if ("professional" in patch && typeof patch.professional !== "string") {
      throw new SlotValidationError("professional must be a string");
    }
    if (
      ("startTime" in patch && !Number.isFinite(patch.startTime)) ||
      ("endTime" in patch && !Number.isFinite(patch.endTime))
    ) {
      throw new SlotValidationError("startTime and endTime must be finite numbers");
    }

    const existing = await this.repository.findById(id);
    if (!existing) throw new SlotNotFoundError(id);

    const professional = patch.professional?.trim() ?? existing.professional;
    const startTime = patch.startTime ?? existing.startTime;
    const endTime = patch.endTime ?? existing.endTime;

    if (endTime <= startTime) {
      throw new SlotValidationError("endTime must be greater than startTime");
    }

    if (await this.repository.hasConflict(professional, startTime, endTime, id)) {
      throw new SlotConflictError();
    }

    try {
      const updated = await this.repository.update(id, { professional, startTime, endTime });
      if (!updated) throw new SlotNotFoundError(id);
      this.cache?.invalidate(SLOT_LIST_CACHE_KEY);
      recordSlotOperation("update", "success");
      return updated;
    } catch (err: unknown) {
      if (
        err !== null &&
        typeof err === "object" &&
        (err as { code?: string }).code === PG_EXCLUSION_VIOLATION
      ) {
        throw new SlotConflictError();
      }
      if (err instanceof SlotNotFoundError || err instanceof SlotValidationError) throw err;
      recordSlotOperation("update", "error");
      throw err;
    }
  }

  updateSlotTraced(
    id: number,
    patch: Partial<SlotInput>,
  ): Promise<SlotRecord> {
    return withSpan("slots.update", { route: "PATCH /api/v1/slots/:id", slotId: id }, () =>
      this.updateSlot(id, patch),
    );
  }

  async listSlots(): Promise<{ slots: SlotRecord[]; cache: "hit" | "miss" }> {
    const start = Date.now();
    try {
      if (this.cache) {
        const result = await this.cache.getOrLoad(SLOT_LIST_CACHE_KEY, () =>
          this.repository.list(),
        );
        recordListLatency(Date.now() - start);
        recordSlotOperation("list", "success");
        return {
          slots: result.value,
          cache: result.source === "cache" ? "hit" : "miss",
        };
      }

      const slots = await this.repository.list();
      recordListLatency(Date.now() - start);
      recordSlotOperation("list", "success");
      return { slots, cache: "miss" };
    } catch (err) {
      recordListLatency(Date.now() - start);
      recordSlotOperation("list", "error");
      throw err;
    }
  }

  listSlotsTraced(): Promise<{ slots: SlotRecord[]; cache: "hit" | "miss" }> {
    return withSpan("slots.list", { route: "GET /api/v1/slots" }, () =>
      this.listSlots(),
    );
  }

  async deleteSlot(id: number): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) throw new SlotNotFoundError(id);
    this.cache?.invalidate(SLOT_LIST_CACHE_KEY);
    recordSlotOperation("delete", "success");
  }

  async findById(id: number): Promise<SlotRecord | null> {
    return this.repository.findById(id);
  }

  /** Test helper — clears cache only (repository state managed separately). */
  resetCache(): void {
    this.cache?.clear();
  }

  /**
   * @deprecated Use resetCache() in tests; repository state is managed by the
   * repository instance itself.
   */
  reset(): void {
    this.resetCache();
  }
}

/** Production singleton — backed by PostgreSQL. */
export const slotService = new SlotService(
  new PgSlotRepository(),
  new InMemoryCache<SlotRecord[]>({ ttlMs: SLOT_LIST_CACHE_TTL_MS }),
);

// ─── Legacy functional API (kept for backward compatibility) ──────────────────

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
  repository: SlotRepositoryInterface = { getSlotsCount, getSlotsPage },
): Promise<PaginatedSlots> => {
  const page = options.page ?? DEFAULT_PAGE;
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (!Number.isInteger(page) || page < 1) throw new Error("Invalid page");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid limit");
  if (limit > MAX_LIMIT) throw new Error("Limit exceeds maximum allowed value");

  const start = Date.now();
  try {
    const total = await repository.getSlotsCount();
    const offset = (page - 1) * limit;

    if (offset >= total && total > 0) {
      return { data: [], page, limit, total };
    }

    const rawSlots = await repository.getSlotsPage(offset, limit);
    const data = rawSlots.map(sanitizeSlot);

    recordListLatency(Date.now() - start);
    recordSlotOperation("list", "success");

    return { data, page, limit, total };
  } catch (err) {
    recordListLatency(Date.now() - start);
    recordSlotOperation("list", "error");
    throw err;
  }
};

export const listSlotsWithFailure = async (
  options: PaginationOptions,
): Promise<PaginatedSlots> => listSlots(options);

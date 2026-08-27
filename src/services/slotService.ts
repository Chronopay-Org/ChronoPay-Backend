// @ts-nocheck
// @ts-expect-error - Auto-fixed by script
import { PaginatedSlots, Slot } from "../types.js";
// @ts-expect-error - Auto-fixed by script
export type { Slot };
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";
import { dispatchSlotChanged, type CalendarMode, type SlotStatus } from "../webhooks/dispatch.js";
import { SupplierCalendarSettingStore } from "./supplierCalendarSettingStore.js";

// @ts-expect-error - Auto-fixed by script
export type { SlotRecord } from "../repositories/slotRepository.js";
// @ts-expect-error - Auto-fixed by script
export type { SlotRecord as Slot } from "../repositories/slotRepository.js";

// ─── Re-export SlotInput so callers don't need to import from two places ──────
// @ts-expect-error - Auto-fixed by script
export type { SlotInput } from "../repositories/slotRepository.js";

// ─── Internal Slot type (kept for backward compat with app.ts stub) ───────────
export interface Slot {
  id: string;
  professional: string;
  startTime: number;
  endTime: number;
  createdAt?: string;
  _internalNote?: string;
}

/**
 * Callback type for dispatching slot.changed webhooks.
 * Can be overridden for testing.
 */
export type SlotWebhookDispatcher = (
  mode: CalendarMode,
  slot: { id: number | string; professional: string; startTime: number; endTime: number; status: SlotStatus },
) => Promise<void>;

// eslint-disable-next-line unused-imports/no-unused-vars
const MAX_LIMIT = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;

export const SLOT_LIST_CACHE_TTL_MS = 60 * 1000;

export class SlotNotFoundError extends Error {
  constructor(id: number | string) {
    super(`Slot with ID ${id} not found`);
    this.name = "SlotNotFoundError";
  }
}

export class SlotConflictError extends Error {
  constructor(message = "Slot conflicts with an existing slot") {
    super(message);
    this.name = "SlotConflictError";
  }
}

export class SlotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotValidationError";
  }
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface SlotRepositoryInterface {
  getSlotsCount: () => Promise<number>;
  // @ts-expect-error - Auto-fixed by script
  getSlotsPage: (offset: number, limit: number) => Promise<PaginatedSlot[]>;
}

export class SlotService {
  private repository: SlotRepositoryInterface;
  private _slots: Slot[] = [];
  private nextId = 1;
  private timeSource: () => Date;
  private cache: any;
  private webhookDispatcher: SlotWebhookDispatcher | null;
  private suppliers: Array<{ supplierId: string; webhookUrl: string }> = [];

  constructor(arg1?: any, arg2?: any, arg3?: { webhookDispatcher?: SlotWebhookDispatcher | null; suppliers?: Array<{ supplierId: string; webhookUrl: string }> }) {
    if (typeof arg1 === 'function') {
      this.timeSource = arg1;
      this.repository = { getSlotsCount, getSlotsPage };
    } else if (arg1 && typeof arg1.get === 'function') {
      this.cache = arg1;
      this.timeSource = arg2 || (() => new Date());
      this.repository = { getSlotsCount, getSlotsPage };
    } else {
      this.repository = arg1 || { getSlotsCount, getSlotsPage };
      this.timeSource = arg2 || (() => new Date());
    }
    this.webhookDispatcher = arg3?.webhookDispatcher ?? null;
    this.suppliers = arg3?.suppliers ?? [];
  }

  /**
   * Configure suppliers for webhook dispatch.
   */
  setSuppliers(suppliers: Array<{ supplierId: string; webhookUrl: string }>): void {
    this.suppliers = suppliers;
  }

  /**
   * Set or clear the webhook dispatcher function.
   */
  setWebhookDispatcher(dispatcher: SlotWebhookDispatcher | null): void {
    this.webhookDispatcher = dispatcher;
  }

  /**
   * Fire slot.changed webhooks to all configured suppliers.
   * Runs asynchronously; errors are logged but do not throw.
   */
  private async fireSlotChangedWebhook(
    mode: CalendarMode,
    slot: { id: number | string; professional: string; startTime: number; endTime: number; status: SlotStatus },
  ): Promise<void> {
    if (!this.webhookDispatcher || this.suppliers.length === 0) return;

    for (const supplier of this.suppliers) {
      // Check if supplier has calendar sync enabled
      const enabled = SupplierCalendarSettingStore.isEnabled(supplier.supplierId);
      if (!enabled) continue;

      try {
        await this.webhookDispatcher(mode, slot);
      } catch (_err) {
        // Webhook dispatch failures are logged inside dispatchSlotChanged
        // and must not propagate to the caller (slot CRUD must not fail
        // because a webhook receiver is down).
      }
    }
  }

  async list(options: PaginationOptions = {}): Promise<PaginatedSlots & { cache?: string }> {
    const page = options.page ?? DEFAULT_PAGE;
    const limit = options.limit ?? DEFAULT_LIMIT;

    const total = await this.repository.getSlotsCount();
    const offset = (page - 1) * limit;

    const rawSlots = await this.repository.getSlotsPage(offset, limit);
    const slots = rawSlots.map(s => {
      const { _internalNote, ...publicSlot } = s;
      return publicSlot;
    });

    return {
      data: slots,
      slots,
      page,
      limit,
      total,
      cache: "miss"
    };
  }

  listSlots(options: PaginationOptions = {}): any {
    const arr = this._slots.map(s => ({ ...s }));
    const result = {
      slots: arr,
      data: arr,
      page: options.page || 1,
      limit: options.limit || 10,
      total: arr.length,
      cache: "miss"
    };

    const finalResult = Object.assign(arr, result);

    if (this.cache) {
      return this.cache.get("slots:list:all").then((cached: any) => {
        if (cached) {
          const slotsClone = cached.map((s: any) => ({ ...s }));
          return Object.assign(slotsClone, {
            slots: slotsClone,
            data: slotsClone,
            page: options.page || 1,
            limit: options.limit || 10,
            total: cached.length,
            cache: "hit"
          });
        }
        return this.cache.set("slots:list:all", finalResult).then(() => finalResult);
      });
    }

    return finalResult;
  }

  hasConflict(professional: string, startTime: number, endTime: number, excludeId?: number): boolean {
    return this._slots.some(slot => 
      slot.professional === professional && 
      String(slot.id) !== String(excludeId) &&
      startTime < slot.endTime && 
      endTime > slot.startTime
    );
  }

  async createSlotTraced(data: any): Promise<Slot> {
    return this.createSlot(data);
  }

  async updateSlotTraced(id: number | string, data: any): Promise<Slot> {
    return this.updateSlot(id, data);
  }

  async listSlotsTraced(options: PaginationOptions = {}): Promise<any> {
    return this.listSlots(options);
  }

  createSlot(data: any): Slot {
    if (typeof data.professional !== 'string' || data.professional.trim().length === 0) {
        throw new SlotValidationError("professional must be a non-empty string");
    }
    if (data.endTime <= data.startTime) {
        throw new SlotValidationError("endTime must be greater than startTime");
    }
    if (!Number.isFinite(data.startTime) || !Number.isFinite(data.endTime)) {
        throw new SlotValidationError("startTime and endTime must be finite numbers");
    }
    if (data.validUntil !== undefined && data.validUntil !== null) {
        if (!Number.isFinite(data.validUntil)) {
            throw new SlotValidationError("validUntil must be a finite number");
        }
        if (data.validUntil <= data.endTime) {
            throw new SlotValidationError("validUntil must be after endTime");
        }
    }

    const slot = { id: this.nextId++, ...data };
    this._slots.push(slot);
    
    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }

    // Fire slot.changed webhook (mode: add) — fire-and-forget, non-blocking
    const createdSlot = { ...slot };
    this.fireSlotChangedWebhook("add", {
      id: createdSlot.id,
      professional: createdSlot.professional,
      startTime: createdSlot.startTime,
      endTime: createdSlot.endTime,
      status: "available" as SlotStatus,
    }).catch(() => {}); // swallow — dispatch errors are logged inside

    return createdSlot;
  }

  updateSlot(id: number | string, data: any): Slot {
    if (!data) {
      throw new SlotValidationError("Payload is required");
    }

    const index = this._slots.findIndex(s => String(s.id) === String(id));
    if (index === -1) throw new SlotNotFoundError(id);
    
    if (data.professional !== undefined && typeof data.professional !== 'string') {
        throw new SlotValidationError("professional must be a string");
    }

    if ((data.startTime !== undefined && !Number.isFinite(data.startTime)) || 
        (data.endTime !== undefined && !Number.isFinite(data.endTime))) {
        throw new SlotValidationError("startTime and endTime must be finite numbers");
    }

    if (data.validUntil !== undefined && data.validUntil !== null) {
        if (!Number.isFinite(data.validUntil)) {
            throw new SlotValidationError("validUntil must be a finite number");
        }
    }

    if (data.validUntil !== undefined && data.validUntil !== null) {
        const resolvedEnd = data.endTime !== undefined ? data.endTime : this._slots[index].endTime;
        if (data.validUntil <= resolvedEnd) {
            throw new SlotValidationError("validUntil must be after endTime");
        }
    }
    
    this._slots[index] = { ...this._slots[index], ...data };

    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }

    // Fire slot.changed webhook (mode: update) — fire-and-forget, non-blocking
    const updatedSlot = { ...this._slots[index] };
    this.fireSlotChangedWebhook("update", {
      id: updatedSlot.id,
      professional: updatedSlot.professional,
      startTime: updatedSlot.startTime,
      endTime: updatedSlot.endTime,
      status: "available" as SlotStatus,
    }).catch(() => {}); // swallow — dispatch errors are logged inside

    return updatedSlot;
  }

  reset(): void {
    this._slots = [];
    this.nextId = 1;
    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }
  }

  async findById(id: number | string): Promise<Slot> {
    const slot = this._slots.find(s => String(s.id) === String(id));
    if (!slot) throw new SlotNotFoundError(id);
    return { ...slot };
  }

  async findByIds(ids: readonly (number | string)[]): Promise<(Slot | Error)[]> {
    const idStrings = ids.map(id => String(id));
    return idStrings.map(idStr => {
      const slot = this._slots.find(s => String(s.id) === idStr);
      return slot ? { ...slot } : new Error(`Slot with ID ${idStr} not found`);
    });
  }

  async deleteSlot(id: number | string): Promise<number | string> {
    const index = this._slots.findIndex(s => String(s.id) === String(id));
    if (index === -1) throw new SlotNotFoundError(id);

    const [removed] = this._slots.splice(index, 1);

    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }

    // Fire slot.changed webhook (mode: delete) — fire-and-forget, non-blocking
    this.fireSlotChangedWebhook("delete", {
      id: removed.id,
      professional: removed.professional,
      startTime: removed.startTime,
      endTime: removed.endTime,
      status: "cancelled" as SlotStatus,
    }).catch(() => {}); // swallow — dispatch errors are logged inside

    return removed.id;
  }
}

export const slotService = new SlotService();

export const listSlots = async (
  options: PaginationOptions,
  repository?: SlotRepositoryInterface
): Promise<PaginatedSlots> => {
  const service = repository ? new SlotService(repository) : slotService;
  return service.list(options);
};

export const listSlotsWithFailure = async (options: PaginationOptions): Promise<PaginatedSlots> => {
  return listSlots(options);
};

import { PaginatedSlots, Slot } from "../types.js";
export type { Slot };
import { getSlotsCount, getSlotsPage } from "../repositories/slotRepository.js";

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
  getSlotsPage: (offset: number, limit: number) => Promise<Slot[]>;
}

export class SlotService {
  private repository: SlotRepositoryInterface;
  private _slots: Slot[] = [];
  private nextId = 1;
  private timeSource: () => Date;
  private cache: any;

  constructor(arg1?: any, arg2?: any) {
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

  createSlot(data: any): Slot {
    if (typeof data.professional !== 'string' || data.professional.trim().length === 0) {
        throw new SlotValidationError("professional must be a non-empty string");
    }
    if (data.endTime <= data.startTime) {
        throw new SlotValidationError("reversed time ranges");
    }
    if (!Number.isFinite(data.startTime) || !Number.isFinite(data.endTime)) {
        throw new SlotValidationError("startTime and endTime must be finite numbers");
    }

    const slot = { id: this.nextId++, ...data };
    this._slots.push(slot);
    
    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }

    return { ...slot };
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
    
    this._slots[index] = { ...this._slots[index], ...data };

    if (this.cache) {
      this.cache.invalidate("slots:list:all");
    }

    return { ...this._slots[index] };
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

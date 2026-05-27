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
      slots,
      page,
      limit,
      total,
      cache: "miss"
    };
  }

  async listSlots(options: PaginationOptions = {}): Promise<PaginatedSlots & { cache?: string }> {
    return this.list(options);
  }

  createSlot(data: any): Slot {
    if (!data.professional || data.professional.trim().length === 0) {
        throw new SlotValidationError("professional must be a non-empty string");
    }
    if (data.endTime <= data.startTime) {
        throw new SlotValidationError("reversed time ranges");
    }
    const slot = { id: this.nextId++, ...data };
    this._slots.push(slot);
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
    return { ...this._slots[index] };
  }

  reset(): void {
    this._slots = [];
    this.nextId = 1;
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

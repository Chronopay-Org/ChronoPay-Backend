import type { SlotRecord } from "./repositories/slotRepository.js";

export type Slot = SlotRecord;

export interface PaginatedSlots {
  slots: Slot[];
  data: Slot[];
  page: number;
  limit: number;
  total: number;
}
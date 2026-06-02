export interface Slot {
  id: number;
  professional: string;
  startTime: number | string;
  endTime: number | string;
  category?: string;
  price_cents?: number;
  supplier_rating?: number;
  // Internal-only field should never be exposed
  _internalNote?: string;
}

export interface PaginatedSlots {
  slots: Slot[];
  data: Slot[];
  page: number;
  limit: number;
  total: number;
}

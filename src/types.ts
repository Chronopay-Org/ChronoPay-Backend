export interface Slot {
  id: number;
  professional: string;
  startTime: number | string;
  endTime: number | string;
  // Internal-only field should never be exposed
  _internalNote?: string;
}

export interface PaginatedSlots {
  slots: Slot[];
  page: number;
  limit: number;
  total: number;
}

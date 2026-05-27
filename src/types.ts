export interface Slot {
  id: string;
  title: string;
  startsAt: string; // ISO 8601
  endsAt: string; // ISO 8601
  available: boolean;
  // Internal-only field should never be exposed
  _internalNote?: string;
}

export interface PaginatedSlots {
  data: Slot[];
  page: number;
  limit: number;
  total: number;
}

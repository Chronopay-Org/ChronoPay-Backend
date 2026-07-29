export interface Slot {
  id: number;
  professional: string;
  startTime: number | string;
  endTime: number | string;
  category?: string;
  price_cents?: number;
  supplier_rating?: number;
  // Populated only for geo-radius search results (see marketplaceSearchService.ts)
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
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
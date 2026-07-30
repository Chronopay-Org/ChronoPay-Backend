export interface Slot {
  id: number;
  professional: string;
  startTime: number | string;
  endTime: number | string;
  category?: string;
  price_cents?: number;
  supplier_rating?: number;
  tags?: string[];
  // Populated only for geo-radius search results (see marketplaceSearchService.ts)
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
  /**
   * Unix epoch ms of the earliest time the hold on this slot is expected to
   * expire. Present only when suppressHeld=false AND showHeldReleaseEta=true
   * and the slot is currently under an active hold.
   */
  heldReleaseEta?: number;
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
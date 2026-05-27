export interface DeliveryMetrics {
  delivered: number;
  skipped: number;
  failed: number;
}

const counters: DeliveryMetrics = { delivered: 0, skipped: 0, failed: 0 };

export const reminderMetrics = {
  increment(key: keyof DeliveryMetrics) {
    counters[key]++;
  },
  snapshot(): DeliveryMetrics {
    return { ...counters };
  },
  /** Reset counters — for use in tests only. */
  reset() {
    counters.delivered = 0;
    counters.skipped = 0;
    counters.failed = 0;
  },
};

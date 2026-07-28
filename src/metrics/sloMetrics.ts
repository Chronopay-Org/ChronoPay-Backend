import { createBudgetedGauge } from "../metrics.js";

export type RouteName = "booking_intent" | "slots_list" | "checkout";
export type WindowName = "5m" | "1h" | "6h";

export const WINDOWS_MS: Record<WindowName, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
};

export const SLO_OBJECTIVES: Record<RouteName, number> = {
  booking_intent: 0.999, // 99.9%
  slots_list: 0.995,     // 99.5%
  checkout: 0.9999,      // 99.99%
};

// Use an internal gauge wrapper to emit metric
export const sloBurnRateGauge = createBudgetedGauge({
  name: "slo_burn_rate",
  help: "Burn rate of the error budget for a given route and window",
  labels: ["route", "window"],
  budget: 20, // Enough for 3 routes * 3 windows
});

interface EventBucket {
  timestamp: number;
  total: number;
  errors: number;
}

const BUCKET_SIZE_MS = 60 * 1000; // 1 min

export class RouteMetrics {
  private buckets: EventBucket[] = [];
  
  constructor(public readonly route: RouteName) {}
  
  record(error: boolean, now: number = Date.now()) {
    const bucketTime = Math.floor(now / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
    
    let currentBucket = this.buckets.length > 0 ? this.buckets[this.buckets.length - 1] : null;
    if (!currentBucket || currentBucket.timestamp !== bucketTime) {
      currentBucket = { timestamp: bucketTime, total: 0, errors: 0 };
      this.buckets.push(currentBucket);
    }
    
    currentBucket.total++;
    if (error) currentBucket.errors++;
    
    // Prune old buckets beyond 6h
    const cutoff = now - WINDOWS_MS["6h"];
    while (this.buckets.length > 0 && this.buckets[0].timestamp < cutoff) {
      this.buckets.shift();
    }
  }
  
  getBurnRate(window: WindowName, now: number = Date.now()): number {
    const cutoff = now - WINDOWS_MS[window];
    let total = 0;
    let errors = 0;
    
    for (const b of this.buckets) {
      if (b.timestamp >= cutoff) {
        total += b.total;
        errors += b.errors;
      }
    }
    
    if (total === 0) return 0; // No traffic -> 0 burn rate
    
    const errorRatio = errors / total;
    const errorBudget = 1 - SLO_OBJECTIVES[this.route];
    
    return errorRatio / errorBudget;
  }
  
  updateGauges(now: number = Date.now()) {
    for (const w of Object.keys(WINDOWS_MS) as WindowName[]) {
      sloBurnRateGauge.labels(this.route, w).set(this.getBurnRate(w, now));
    }
  }

  // For testing
  _getBuckets() {
    return this.buckets;
  }
}

const routeMetrics: Record<string, RouteMetrics> = {
  booking_intent: new RouteMetrics("booking_intent"),
  slots_list: new RouteMetrics("slots_list"),
  checkout: new RouteMetrics("checkout"),
};

export function recordRouteTraffic(route: RouteName, isError: boolean, now: number = Date.now()) {
  const rm = routeMetrics[route];
  if (rm) {
    rm.record(isError, now);
    rm.updateGauges(now);
  }
}

export function resetSloMetrics() {
  for (const route of Object.keys(routeMetrics) as RouteName[]) {
    routeMetrics[route] = new RouteMetrics(route);
  }
}

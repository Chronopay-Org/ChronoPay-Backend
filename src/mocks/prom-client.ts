/** Minimal prom-client stub for test environments. */

export class Registry {
  getSingleMetric(_name: string) { return undefined; }
  get contentType() { return "text/plain"; }
  async metrics() { return ""; }
}

export function collectDefaultMetrics(_opts?: unknown) {}

export class Histogram {
  observations: number[] = [];
  constructor(_opts: unknown) {}
  labels(..._args: unknown[]) { return this; }
  observe(value: number) { this.observations.push(value); }
  reset() { this.observations = []; }
}

export class Counter {
  hashMap: Record<string, { value: number }> = { "": { value: 0 } };
  constructor(_opts: unknown) {}
  inc(amount = 1) { this.hashMap[""].value += amount; }
  reset() { this.hashMap[""].value = 0; }
}

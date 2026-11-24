import { describe, it, expect } from "@jest/globals";
import { startTzDriftMonitor } from "../scheduler/tzDriftMonitorWiring.js";
import { InMemorySlotRepository, type SlotRecord } from "../modules/slots/slot-repository.js";
import { tzDriftSlotsScannedTotal } from "../metrics.js";

const slots: SlotRecord[] = Array.from({ length: 5 }, (_, i) => ({
  id: `slot-${i}`,
  professional: "pro-1",
  startTime: Date.UTC(2026, 5, 1, 8 + i),
  endTime: Date.UTC(2026, 5, 1, 9 + i),
}));

function fakeLifecycle() {
  const hooks = new Map<string, () => Promise<void> | void>();
  return { hooks, registerStop: (n: string, c: () => Promise<void> | void) => void hooks.set(n, c) };
}

async function scanned(): Promise<number> {
  return (await tzDriftSlotsScannedTotal.get()).values[0]?.value ?? 0;
}

describe("startTzDriftMonitor", () => {
  it("skips entirely when TZ_DRIFT_MONITOR_DISABLED=true", async () => {
    const lifecycle = fakeLifecycle();
    const before = await scanned();

    const started = startTzDriftMonitor(
      lifecycle,
      new InMemorySlotRepository(slots),
      { TZ_DRIFT_MONITOR_DISABLED: "true" },
    );

    expect(started).toBe(false);
    expect(lifecycle.hooks.size).toBe(0);
    expect(await scanned()).toBe(before);
  });

  it("scans real slots, updates the gauge, and stops cleanly via the lifecycle hook", async () => {
    const lifecycle = fakeLifecycle();
    const before = await scanned();

    const started = startTzDriftMonitor(lifecycle, new InMemorySlotRepository(slots), {});

    expect(started).toBe(true);
    expect(lifecycle.hooks.has("tz-drift-monitor")).toBe(true);
    // The first sweep runs synchronously on start.
    expect((await scanned()) - before).toBe(5);

    await lifecycle.hooks.get("tz-drift-monitor")!();
  });
});

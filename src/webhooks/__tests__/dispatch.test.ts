// @ts-nocheck
import { jest } from "@jest/globals";
import {
  buildSlotChangedEvent,
  dispatchSlotChanged,
  dispatchSlotChangedToAll,
  type DispatchSlotChangedOptions,
} from "../dispatch.js";
import { SupplierCalendarSettingStore } from "../../services/supplierCalendarSettingStore.js";

// ─── Mocks ─────────────────────────────────────────────────────────────────

jest.mock("../../utils/logger.js", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

jest.mock("../../config/timeouts.js", () => ({
  timeoutConfig: {
    http: { webhookMs: 5000 },
    retry: { maxAttempts: 2, baseDelayMs: 10, maxTotalBudgetMs: 5000 },
  },
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body?: string }>) {
  let callIndex = 0;
  return jest.fn(async () => {
    const resp = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return {
      status: resp.status,
      text: async () => resp.body ?? "",
      ok: resp.status >= 200 && resp.status < 300,
    };
  });
}

function validOptions(overrides: Partial<DispatchSlotChangedOptions> = {}): DispatchSlotChangedOptions {
  return {
    slotId: "slot-1",
    mode: "add",
    start: 1700000000000,
    end: 1700003600000,
    status: "available",
    professional: "Dr. Smith",
    webhookUrl: "https://supplier.example.com/webhook",
    supplierId: "supplier-abc",
    signingSecret: "test-secret",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("buildSlotChangedEvent", () => {
  it("should build a valid slot.changed event envelope", () => {
    const event = buildSlotChangedEvent({
      slotId: "slot-42",
      mode: "add",
      start: 1700000000000,
      end: 1700003600000,
      status: "available",
      professional: "Dr. Jones",
    });

    expect(event.event).toBe("slot.changed");
    expect(event.timestamp).toBeDefined();
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(event.idempotencyKey).toMatch(/^slot-42:add:\d+$/);
    expect(event.calendar.slotId).toBe("slot-42");
    expect(event.calendar.mode).toBe("add");
    expect(event.calendar.start).toBe(1700000000000);
    expect(event.calendar.end).toBe(1700003600000);
    expect(event.calendar.duration).toBe(3600000);
    expect(event.calendar.status).toBe("available");
    expect(event.calendar.professional).toBe("Dr. Jones");
  });

  it("should use provided version for idempotency key", () => {
    const event = buildSlotChangedEvent({
      slotId: 1,
      mode: "update",
      start: 1000,
      end: 2000,
      status: "booked",
      professional: "Dr. Smith",
      version: 42,
    });

    expect(event.idempotencyKey).toBe("1:update:42");
  });

  it("should use Date.now() as default version", () => {
    const before = Date.now();
    const event = buildSlotChangedEvent({
      slotId: "s1",
      mode: "delete",
      start: 1000,
      end: 2000,
      status: "cancelled",
      professional: "Dr. Smith",
    });
    const after = Date.now();

    // Extract version from idempotency key
    const version = parseInt(event.idempotencyKey.split(":")[2], 10);
    expect(version).toBeGreaterThanOrEqual(before);
    expect(version).toBeLessThanOrEqual(after);
  });

  it("should calculate duration correctly (end - start)", () => {
    const event = buildSlotChangedEvent({
      slotId: 1,
      mode: "add",
      start: 100000,
      end: 250000,
      status: "available",
      professional: "Dr. Smith",
    });

    expect(event.calendar.duration).toBe(150000);
  });

  it("should accept numeric slotId", () => {
    const event = buildSlotChangedEvent({
      slotId: 999,
      mode: "add",
      start: 1000,
      end: 2000,
      status: "available",
      professional: "Dr. Smith",
    });

    expect(event.calendar.slotId).toBe(999);
  });

  it("should accept string slotId", () => {
    const event = buildSlotChangedEvent({
      slotId: "abc-123",
      mode: "add",
      start: 1000,
      end: 2000,
      status: "available",
      professional: "Dr. Smith",
    });

    expect(event.calendar.slotId).toBe("abc-123");
  });
});

describe("dispatchSlotChanged", () => {
  beforeEach(() => {
    SupplierCalendarSettingStore.clear();
  });

  it("should return success for a valid 2xx response", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("should return 201 for a 201 response", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 201 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(201);
  });

  it("should skip dispatch when supplier is not opted in", async () => {
    // Don't enable the supplier
    const fetchFn = mockFetch([{ status: 200 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("should skip dispatch when supplier setting does not exist", async () => {
    const fetchFn = mockFetch([{ status: 200 }]);

    const result = await dispatchSlotChanged({
      ...validOptions({ supplierId: "unknown-supplier" }),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("should return failure for 4xx without retrying", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 400 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(fetchFn).toHaveBeenCalledTimes(1); // No retry for 4xx
  });

  it("should return failure for 401 without retrying", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 401 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("should return failure for 403 without retrying", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 403 }]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("should retry on 5xx and succeed on second attempt", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([
      { status: 500 },
      { status: 200 },
    ]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("should retry on 502 and eventually fail if all retries exhausted", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([
      { status: 502 },
      { status: 502 },
      { status: 502 },
    ]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(false);
    // maxAttempts=2 from mock config => 1 initial + 2 retries = 3 total calls
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("should retry on 503 (service unavailable)", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([
      { status: 503 },
      { status: 200 },
    ]);

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("should retry on network error and eventually succeed", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    let callCount = 0;
    const fetchFn = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("ECONNRESET");
      }
      return { status: 200, text: async () => "", ok: true };
    });

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("should include HMAC signature in headers when signingSecret is provided", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ signingSecret: "my-secret" }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("should not include signature header when signingSecret is not provided", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ signingSecret: undefined }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers["X-Webhook-Signature"]).toBeUndefined();
  });

  it("should include correct Content-Type and X-Webhook-Event headers", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Webhook-Event"]).toBe("slot.changed");
    expect(headers["X-Supplier-Id"]).toBe("supplier-abc");
  });

  it("should send a valid JSON body with slot.changed event", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.event).toBe("slot.changed");
    expect(body.calendar).toBeDefined();
    expect(body.calendar.slotId).toBe("slot-1");
    expect(body.calendar.mode).toBe("add");
    expect(body.calendar.start).toBe(1700000000000);
    expect(body.calendar.end).toBe(1700003600000);
    expect(body.calendar.duration).toBe(3600000);
    expect(body.calendar.status).toBe("available");
    expect(body.calendar.professional).toBe("Dr. Smith");
    expect(body.idempotencyKey).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });

  it("should handle delete mode correctly", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ mode: "delete", status: "cancelled" }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.mode).toBe("delete");
    expect(body.calendar.status).toBe("cancelled");
  });

  it("should handle update mode correctly", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ mode: "update" }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.mode).toBe("update");
  });

  it("should return network error details when fetch throws", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await dispatchSlotChanged({
      ...validOptions(),
      fetchFn,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

describe("dispatchSlotChangedToAll", () => {
  beforeEach(() => {
    SupplierCalendarSettingStore.clear();
  });

  it("should dispatch to all opted-in suppliers", async () => {
    SupplierCalendarSettingStore.setEnabled("s1", true);
    SupplierCalendarSettingStore.setEnabled("s2", true);
    const fetchFn = mockFetch([{ status: 200 }, { status: 200 }]);

    const result = await dispatchSlotChangedToAll(
      [
        { supplierId: "s1", webhookUrl: "https://s1.example.com/hook" },
        { supplierId: "s2", webhookUrl: "https://s2.example.com/hook" },
      ],
      {
        slotId: "slot-1",
        mode: "add",
        start: 1000,
        end: 2000,
        status: "available",
        professional: "Dr. Smith",
        signingSecret: "secret",
        fetchFn,
      },
    );

    expect(result.dispatched).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("should skip non-opted-in suppliers", async () => {
    SupplierCalendarSettingStore.setEnabled("s1", true);
    // s2 not enabled
    const fetchFn = mockFetch([{ status: 200 }]);

    const result = await dispatchSlotChangedToAll(
      [
        { supplierId: "s1", webhookUrl: "https://s1.example.com/hook" },
        { supplierId: "s2", webhookUrl: "https://s2.example.com/hook" },
      ],
      {
        slotId: "slot-1",
        mode: "add",
        start: 1000,
        end: 2000,
        status: "available",
        professional: "Dr. Smith",
        fetchFn,
      },
    );

    expect(result.dispatched).toBe(2);
    // Both report success: s1 via 200, s2 skipped (returns success:true with statusCode:0)
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    // Only s1 triggered an HTTP call
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("should report partial failure", async () => {
    SupplierCalendarSettingStore.setEnabled("s1", true);
    SupplierCalendarSettingStore.setEnabled("s2", true);
    const fetchFn = mockFetch([
      { status: 200 },
      { status: 400 },
    ]);

    const result = await dispatchSlotChangedToAll(
      [
        { supplierId: "s1", webhookUrl: "https://s1.example.com/hook" },
        { supplierId: "s2", webhookUrl: "https://s2.example.com/hook" },
      ],
      {
        slotId: "slot-1",
        mode: "add",
        start: 1000,
        end: 2000,
        status: "available",
        professional: "Dr. Smith",
        fetchFn,
      },
    );

    expect(result.dispatched).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("should return empty results for no suppliers", async () => {
    const result = await dispatchSlotChangedToAll([], {
      slotId: "slot-1",
      mode: "add",
      start: 1000,
      end: 2000,
      status: "available",
      professional: "Dr. Smith",
    });

    expect(result.dispatched).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("should handle all suppliers disabled", async () => {
    // No suppliers enabled
    const fetchFn = mockFetch([{ status: 200 }]);

    const result = await dispatchSlotChangedToAll(
      [
        { supplierId: "s1", webhookUrl: "https://s1.example.com/hook" },
        { supplierId: "s2", webhookUrl: "https://s2.example.com/hook" },
      ],
      {
        slotId: "slot-1",
        mode: "add",
        start: 1000,
        end: 2000,
        status: "available",
        professional: "Dr. Smith",
        fetchFn,
      },
    );

    expect(result.dispatched).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Edge cases", () => {
  beforeEach(() => {
    SupplierCalendarSettingStore.clear();
  });

  it("should handle empty supplierId gracefully", async () => {
    const result = await dispatchSlotChanged({
      ...validOptions({ supplierId: "" }),
      fetchFn: mockFetch([{ status: 200 }]),
    });

    // Empty supplierId means not opted in
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(0);
  });

  it("should handle whitespace-only supplierId", async () => {
    const result = await dispatchSlotChanged({
      ...validOptions({ supplierId: "   " }),
      fetchFn: mockFetch([{ status: 200 }]),
    });

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(0);
  });

  it("should handle numeric slotId", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ slotId: 42 }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.slotId).toBe(42);
  });

  it("should handle very long professional names", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);
    const longName = "Dr. ".repeat(100) + "Smith";

    await dispatchSlotChanged({
      ...validOptions({ professional: longName }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.professional).toBe(longName);
  });

  it("should handle zero-duration slots", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);

    await dispatchSlotChanged({
      ...validOptions({ start: 1000, end: 1000 }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.duration).toBe(0);
  });

  it("should handle very large timestamps", async () => {
    SupplierCalendarSettingStore.setEnabled("supplier-abc", true);
    const fetchFn = mockFetch([{ status: 200 }]);
    const largeTs = 9999999999999;

    await dispatchSlotChanged({
      ...validOptions({ start: largeTs, end: largeTs + 3600000 }),
      fetchFn,
    });

    const callArgs = fetchFn.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.calendar.start).toBe(largeTs);
  });
});

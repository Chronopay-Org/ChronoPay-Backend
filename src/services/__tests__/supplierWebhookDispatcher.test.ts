import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { dispatchSupplierWebhook, verifySignature } from "../supplierWebhookDispatcher.js";

function makeEvent(overrides: Partial<{ supplierId: string | null }> = {}) {
  return {
    id: "event-1",
    event_type: "slot.reservation.expired",
    aggregate_id: "intent-1",
    payload: {
      slotId: "slot-1",
      start: "2026-08-15T14:30:00.000Z",
      timezone: "UTC",
      reason: "booking_intent_expired",
      supplierId: overrides.supplierId === undefined ? "supplier-1" : overrides.supplierId,
      occurredAt: "2026-08-15T14:45:00.000Z",
    },
    created_at: new Date(),
    acked_at: null,
  };
}

function makeFakePool(rows: Record<string, any[]>) {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = jest.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (text.includes("supplier_webhook_preferences")) return { rows: rows.preferences ?? [] };
    if (text.includes("FROM supplier_webhook_endpoints")) return { rows: rows.endpoints ?? [] };
    if (text.includes("FROM webhook_delivery_attempts")) return { rows: rows.deliveryState ?? [] };
    if (text.includes("INSERT INTO webhook_delivery_attempts")) return { rows: [] };
    if (text.includes("DELETE FROM webhook_delivery_attempts")) return { rows: [] };
    return { rows: [] };
  });
  return { query, calls };
}

describe("dispatchSupplierWebhook", () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  it("does not dispatch when the supplier has opted out", async () => {
    const pool = makeFakePool({ preferences: [{ enabled: false }] });

    await dispatchSupplierWebhook(pool as any, makeEvent() as any);

    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it("dispatches by default when no preference row exists", async () => {
    const pool = makeFakePool({
      preferences: [],
      endpoints: [{ url: "https://supplier.example/hook", secret: "s3cret" }],
      deliveryState: [],
    });
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await dispatchSupplierWebhook(pool as any, makeEvent() as any);

    expect((global as any).fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global as any).fetch.mock.calls[0];
    expect(init.headers["X-ChronoPay-Event"]).toBe("slot.reservation.expired");
    expect(init.headers["X-ChronoPay-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("signs the payload so the supplier can verify it", async () => {
    const secret = "s3cret";
    const pool = makeFakePool({
      preferences: [],
      endpoints: [{ url: "https://supplier.example/hook", secret }],
      deliveryState: [],
    });
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await dispatchSupplierWebhook(pool as any, makeEvent() as any);

    const [, init] = (global as any).fetch.mock.calls[0];
    const signature = init.headers["X-ChronoPay-Signature"].replace("sha256=", "");
    expect(verifySignature(secret, init.body, signature)).toBe(true);
    expect(verifySignature("wrong-secret", init.body, signature)).toBe(false);
  });

  it("records a backoff-eligible failure and retries later, not immediately", async () => {
    const pool = makeFakePool({
      preferences: [],
      endpoints: [{ url: "https://supplier.example/hook", secret: "s3cret" }],
      deliveryState: [],
    });
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(dispatchSupplierWebhook(pool as any, makeEvent() as any)).rejects.toThrow();

    const insertCall = pool.calls.find((c) => c.text.includes("INSERT INTO webhook_delivery_attempts"));
    expect(insertCall).toBeDefined();
  });

  it("does not re-hit the endpoint while backoff is still pending", async () => {
    const future = new Date(Date.now() + 60_000);
    const pool = makeFakePool({
      preferences: [],
      endpoints: [{ url: "https://supplier.example/hook", secret: "s3cret" }],
      deliveryState: [{ attempt_count: 1, next_attempt_at: future }],
    });

    await expect(dispatchSupplierWebhook(pool as any, makeEvent() as any)).rejects.toThrow(/not due/i);

    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it("does nothing when the supplier has no endpoint configured", async () => {
    const pool = makeFakePool({ preferences: [], endpoints: [] });

    await dispatchSupplierWebhook(pool as any, makeEvent() as any);

    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});
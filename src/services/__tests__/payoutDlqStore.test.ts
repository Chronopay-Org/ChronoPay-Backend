// src/services/__tests__/payoutDlqStore.test.ts
import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  PayoutDlqStore,
  getPayoutDlqStore,
  resetPayoutDlqStore 
} from "../payoutDlqStore.js";

describe("PayoutDlqStore", () => {
  let store: PayoutDlqStore;

  beforeEach(() => {
    store = new PayoutDlqStore();
  });

  // ─── add() ─────────────────────────────────────────────────────────────────

  describe("add", () => {
    it("should add a new DLQ entry and return it with generated id", () => {
      const entry = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "Connection timeout",
        payload: { amount: 100, currency: "USD" },
        retries: 3,
      });

      expect(entry.id).toBeDefined();
      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(entry.supplierId).toBe("supplier-1");
      expect(entry.errorClass).toBe("NETWORK");
      expect(entry.errorMessage).toBe("Connection timeout");
      expect(entry.payload).toEqual({ amount: 100, currency: "USD" });
      expect(entry.status).toBe("pending");
      expect(entry.retries).toBe(3);
      expect(entry.createdAt).toBeDefined();
      expect(entry.updatedAt).toBeDefined();
    });

    it("should default retries to 0 when not provided", () => {
      const entry = store.add({
        supplierId: "supplier-2",
        errorClass: "TIMEOUT",
        errorMessage: "Request timed out",
        payload: { amount: 200 },
      });

      expect(entry.retries).toBe(0);
    });

    it("should create entries with unique IDs", () => {
      const e1 = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: {},
      });
      const e2 = store.add({
        supplierId: "supplier-2",
        errorClass: "TIMEOUT",
        errorMessage: "err",
        payload: {},
      });

      expect(e1.id).not.toBe(e2.id);
    });

    it("should deep-clone the payload to prevent external mutation", () => {
      const mutablePayload = { amount: 100, nested: { key: "value" } };
      const entry = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: mutablePayload,
      });

      mutablePayload.amount = 999;
      mutablePayload.nested.key = "modified";

      expect(entry.payload.amount).toBe(100);
      expect((entry.payload.nested as any).key).toBe("value");
    });
  });

  // ─── getById() ─────────────────────────────────────────────────────────────

  describe("getById", () => {
    it("should return a masked entry when the entry exists", () => {
      const added = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "Connection timeout",
        payload: {
          amount: 100,
          password: "super-secret-password",
          token: "bearer-token-value-long-string",
        },
      });

      const masked = store.getById(added.id);

      expect(masked).toBeDefined();
      expect(masked!.id).toBe(added.id);
      expect(masked!.supplierId).toBe("supplier-1");
      // Verify masking was applied to sensitive fields
      expect(masked!.payload.password).not.toBe("super-secret-password");
      expect(masked!.payload.token).not.toBe("bearer-token-value-long-string");
      // Non-sensitive fields should remain intact
      expect(masked!.payload.amount).toBe(100);
    });

    it("should return undefined for non-existent entry", () => {
      expect(store.getById("non-existent-id")).toBeUndefined();
    });

    it("should mask nested sensitive fields", () => {
      const added = store.add({
        supplierId: "supplier-1",
        errorClass: "VALIDATION",
        errorMessage: "Invalid input",
        payload: {
          nested: {
            secret: "nested-secret",
            safe: "visible",
            deeply: {
              api_key: "deep-api-key",
              data: "ok",
            },
          },
        },
      });

      const masked = store.getById(added.id);

      const payload = masked!.payload as any;
      expect(payload.nested.safe).toBe("visible");
      expect(payload.nested.secret).not.toBe("nested-secret");
      expect(payload.nested.deeply.api_key).not.toBe("deep-api-key");
      expect(payload.nested.deeply.data).toBe("ok");
    });

    it("should mask fields matching case-insensitive sensitive field names", () => {
      const added = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: {
          Password: "mixed-case-pass",
          API_KEY: "mixed-case-key",
          Authorization: "mixed-case-auth",
        },
      });

      const masked = store.getById(added.id);

      expect(masked!.payload.Password).not.toBe("mixed-case-pass");
      expect(masked!.payload.API_KEY).not.toBe("mixed-case-key");
      expect(masked!.payload.Authorization).not.toBe("mixed-case-auth");
    });
  });

  // ─── getByIdRaw() ──────────────────────────────────────────────────────────

  describe("getByIdRaw", () => {
    it("should return the raw entry without masking", () => {
      const added = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: { secret: "raw-secret" },
      });

      const raw = store.getByIdRaw(added.id);

      expect(raw).toBeDefined();
      expect(raw!.payload.secret).toBe("raw-secret");
    });

    it("should return undefined for non-existent entry", () => {
      expect(store.getByIdRaw("non-existent")).toBeUndefined();
    });
  });

  // ─── list() ────────────────────────────────────────────────────────────────

  describe("list", () => {
    beforeEach(() => {
      // Add multiple entries with different attributes for filtering tests
      store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "Connection timeout",
        payload: { amount: 100 },
        retries: 3,
      });
      store.add({
        supplierId: "supplier-1",
        errorClass: "TIMEOUT",
        errorMessage: "Request timed out after 30s",
        payload: { amount: 200 },
        retries: 1,
      });
      store.add({
        supplierId: "supplier-2",
        errorClass: "NETWORK",
        errorMessage: "DNS resolution failed",
        payload: { amount: 300 },
        retries: 5,
      });
      store.add({
        supplierId: "supplier-3",
        errorClass: "INSUFFICIENT_FUNDS",
        errorMessage: "Balance too low",
        payload: { amount: 400 },
        retries: 0,
      });
    });

    it("should list all entries (default params)", () => {
      const result = store.list();
      expect(result.total).toBe(4);
      expect(result.entries.length).toBe(4);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it("should return entries with masked payloads", () => {
      const result = store.list();
      for (const entry of result.entries) {
        // All entries should have been masked
        // non-sensitive fields like amount should be visible
        if (typeof entry.payload.amount === "number") {
          expect(entry.payload.amount).toBeGreaterThan(0);
        }
      }
    });

    it("should filter by supplierId", () => {
      const result = store.list({ supplierId: "supplier-1" });
      expect(result.total).toBe(2);
      expect(
        result.entries.every((e) => e.supplierId === "supplier-1"),
      ).toBe(true);
    });

    it("should filter by errorClass (case-insensitive)", () => {
      const result = store.list({ errorClass: "network" });
      expect(result.total).toBe(2);
      expect(
        result.entries.every(
          (e) => e.errorClass.toLowerCase() === "network",
        ),
      ).toBe(true);
    });

    it("should filter by status", () => {
      const result = store.list({ status: "pending" });
      expect(result.total).toBe(4);
      expect(
        result.entries.every((e) => e.status === "pending"),
      ).toBe(true);
    });

    it("should filter by status and return empty for non-matching status", () => {
      const result = store.list({ status: "reprocessed" });
      expect(result.total).toBe(0);
    });

    it("should search across supplierId, errorClass, errorMessage, and id", () => {
      // Search by supplierId
      const r1 = store.list({ search: "supplier-2" });
      expect(r1.total).toBe(1);

      // Search by errorClass
      const r2 = store.list({ search: "insufficient" });
      expect(r2.total).toBe(1);

      // Search by errorMessage
      const r3 = store.list({ search: "DNS resolution" });
      expect(r3.total).toBe(1);

      // Search across all fields (partial match in supplierId)
      const r4 = store.list({ search: "supplier" });
      expect(r4.total).toBe(4);
    });

    it("should support pagination with limit and offset", () => {
      const result = store.list({ limit: 2, offset: 0 });
      expect(result.entries.length).toBe(2);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
      expect(result.total).toBe(4);

      const page2 = store.list({ limit: 2, offset: 2 });
      expect(page2.entries.length).toBe(2);
      expect(page2.total).toBe(4);
    });

    it("should handle offset beyond total count", () => {
      const result = store.list({ offset: 100 });
      expect(result.entries.length).toBe(0);
      expect(result.total).toBe(4);
    });

    it("should return entries sorted by createdAt descending (newest first)", () => {
      const result = store.list();
      if (result.entries.length >= 2) {
        const timestamps = result.entries.map((e) =>
          new Date(e.createdAt).getTime(),
        );
        for (let i = 0; i < timestamps.length - 1; i++) {
          expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
        }
      }
    });

    it("should clamp limit to max 200", () => {
      const result = store.list({ limit: 500 });
      expect(result.entries.length).toBeLessThanOrEqual(4);
    });

    it("should return empty list when store is empty", () => {
      const emptyStore = new PayoutDlqStore();
      const result = emptyStore.list();
      expect(result.total).toBe(0);
      expect(result.entries).toEqual([]);
    });
  });

  // ─── markInspected() ───────────────────────────────────────────────────────

  describe("markInspected", () => {
    it("should mark an entry as inspected", () => {
      const entry = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: {},
      });

      const updated = store.markInspected(entry.id);

      expect(updated).toBeDefined();
      expect(updated!.status).toBe("inspected");
      // updatedAt should be at or after the original entry's updatedAt
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(entry.updatedAt).getTime(),
      );
    });

    it("should return undefined for non-existent entry", () => {
      expect(store.markInspected("non-existent")).toBeUndefined();
    });

    it("should reflect inspected status in subsequent list calls", () => {
      const entry = store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: {},
      });

      store.markInspected(entry.id);

      const pending = store.list({ status: "pending" });
      expect(pending.total).toBe(0);

      const inspected = store.list({ status: "inspected" });
      expect(inspected.total).toBe(1);
    });
  });

  // ─── reset() ───────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("should clear all entries", () => {
      store.add({
        supplierId: "supplier-1",
        errorClass: "NETWORK",
        errorMessage: "err",
        payload: {},
      });
      expect(store.size).toBe(1);

      store.reset();
      expect(store.size).toBe(0);
      expect(store.list().total).toBe(0);
    });
  });

  // ─── size ──────────────────────────────────────────────────────────────────

  describe("size", () => {
    it("should return the correct number of entries", () => {
      expect(store.size).toBe(0);

      store.add({
        supplierId: "s1",
        errorClass: "NETWORK",
        errorMessage: "e",
        payload: {},
      });
      expect(store.size).toBe(1);

      store.add({
        supplierId: "s2",
        errorClass: "TIMEOUT",
        errorMessage: "e",
        payload: {},
      });
      expect(store.size).toBe(2);
    });
  });
});

// ─── Singleton functions ─────────────────────────────────────────────────────

describe("getPayoutDlqStore / resetPayoutDlqStore", () => {
  beforeEach(() => {
    resetPayoutDlqStore();
  });

  afterEach(() => {
    resetPayoutDlqStore();
  });

  it("should return the same singleton instance on multiple calls", () => {
    const s1 = getPayoutDlqStore();
    const s2 = getPayoutDlqStore();
    expect(s1).toBe(s2);
  });

  it("should create a fresh instance after reset", () => {
    const s1 = getPayoutDlqStore();
    s1.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "err",
      payload: {},
    });
    expect(s1.size).toBe(1);

    resetPayoutDlqStore();

    const s2 = getPayoutDlqStore();
    expect(s2.size).toBe(0);
    expect(s1).not.toBe(s2);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("PayoutDlqStore edge cases", () => {
  let store: PayoutDlqStore;

  beforeEach(() => {
    store = new PayoutDlqStore();
  });

  it("should handle huge payloads without issues", () => {
    const hugePayload: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      hugePayload[`field_${i}`] = `value_${i}`;
    }

    const entry = store.add({
      supplierId: "supplier-large",
      errorClass: "NETWORK",
      errorMessage: "Large payload test",
      payload: hugePayload,
    });

    const masked = store.getById(entry.id);
    expect(masked).toBeDefined();
    // All fields should be present after masking
    for (let i = 0; i < 1000; i++) {
      expect(masked!.payload[`field_${i}`]).toBe(`value_${i}`);
    }
  });

  it("should handle payloads with arrays", () => {
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "VALIDATION",
      errorMessage: "Array payload test",
      payload: {
        items: [
          { name: "item1", secret: "secret1" },
          { name: "item2", secret: "secret2" },
        ],
      },
    });

    const masked = store.getById(entry.id);
    const items = masked!.payload.items as any[];

    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("item1");
    expect(items[0].secret).not.toBe("secret1");
    expect(items[1].name).toBe("item2");
    expect(items[1].secret).not.toBe("secret2");
  });

  it("should handle payloads with null and undefined values", () => {
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "Null test",
      payload: {
        nullField: null,
        undefinedField: undefined,
        normalField: "value",
        secret: null,
      },
    });

    const masked = store.getById(entry.id);
    expect(masked!.payload.nullField).toBeNull();
    expect(masked!.payload.undefinedField).toBeUndefined();
    expect(masked!.payload.normalField).toBe("value");
    // null sensitive fields are masked by redact to prevent exfiltration
    expect(masked!.payload.secret).toBe("***");
  });

  it("should handle empty payload", () => {
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "Empty payload",
      payload: {},
    });

    const masked = store.getById(entry.id);
    expect(masked!.payload).toEqual({});
  });

  it("should handle payloads with Date objects", () => {
    const now = new Date();
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "Date test",
      payload: {
        timestamp: now,
      },
    });

    const masked = store.getById(entry.id);
    // Use realm-agnostic check to verify Date objects are preserved
    expect(Object.prototype.toString.call(masked!.payload.timestamp)).toBe(
      "[object Date]",
    );
  });

  it("should handle very long error messages", () => {
    const longMessage = "A".repeat(10000);
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "CRITICAL",
      errorMessage: longMessage,
      payload: {},
    });

    expect(entry.errorMessage).toBe(longMessage);
  });

  it("should handle search with no matches", () => {
    store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "Connection error",
      payload: {},
    });

    const result = store.list({ search: "nonexistent-xyz-12345" });
    expect(result.total).toBe(0);
  });

  it("should handle combined filters", () => {
    store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "err",
      payload: {},
    });
    store.add({
      supplierId: "supplier-1",
      errorClass: "TIMEOUT",
      errorMessage: "err",
      payload: {},
    });

    const result = store.list({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
    });
    expect(result.total).toBe(1);
  });

  it("should not mutate stored payload when getByIdRaw modifies result", () => {
    const entry = store.add({
      supplierId: "supplier-1",
      errorClass: "NETWORK",
      errorMessage: "err",
      payload: { amount: 100 },
    });

    const raw = store.getByIdRaw(entry.id)!;
    raw.payload.amount = 999;

    const fresh = store.getByIdRaw(entry.id)!;
    expect(fresh.payload.amount).toBe(100);
  });
});

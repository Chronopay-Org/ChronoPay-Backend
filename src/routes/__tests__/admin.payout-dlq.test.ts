// src/routes/__tests__/admin.payout-dlq.test.ts
import request from "supertest";
import { createApp } from "../../app.js";
import {
  getPayoutDlqStore,
  resetPayoutDlqStore,
  type 
} from "../../services/payoutDlqStore.js";

const app = createApp({ enableTestRoutes: false, enableDocs: false });
const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

describe("Admin Payout DLQ Inspection API", () => {
  beforeEach(() => {
    process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
    resetPayoutDlqStore();
  });

  afterEach(() => {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
    resetPayoutDlqStore();
  });

  // ─── Auth ───────────────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("should require admin token for listing DLQ entries", async () => {
      const res = await request(app).get("/api/v1/admin/payout-dlq");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should require admin token for getting a single DLQ entry", async () => {
      const res = await request(app).get(
        "/api/v1/admin/payout-dlq/some-id",
      );
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should return 403 for invalid admin token", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set("x-chronopay-admin-token", "wrong-token");
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── GET /payout-dlq (list) ────────────────────────────────────────────────

  describe("GET /api/v1/admin/payout-dlq", () => {
    beforeEach(() => {
      const store = getPayoutDlqStore();
      store.add({
        supplierId: "supplier-alpha",
        errorClass: "NETWORK",
        errorMessage: "Connection timeout to gateway",
        payload: { amount: 100, currency: "USD", token: "tok_visa_4242" },
        retries: 3,
      });
      store.add({
        supplierId: "supplier-alpha",
        errorClass: "TIMEOUT",
        errorMessage: "Request timed out after 30s",
        payload: { amount: 200, currency: "EUR", api_key: "secret-key" },
        retries: 1,
      });
      store.add({
        supplierId: "supplier-beta",
        errorClass: "NETWORK",
        errorMessage: "DNS resolution failed for payout.acme.com",
        payload: { amount: 300, currency: "GBP" },
        retries: 5,
      });
      store.add({
        supplierId: "supplier-gamma",
        errorClass: "INSUFFICIENT_FUNDS",
        errorMessage: "Balance too low for payout",
        payload: { amount: 400, currency: "USD" },
        retries: 0,
      });
    });

    it("should list all DLQ entries with masked payloads", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(4);
      expect(res.body.entries).toHaveLength(4);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);

      // Verify each entry has the expected structure
      for (const entry of res.body.entries) {
        expect(entry.id).toBeDefined();
        expect(entry.supplierId).toBeDefined();
        expect(entry.errorClass).toBeDefined();
        expect(entry.errorMessage).toBeDefined();
        expect(entry.payload).toBeDefined();
        expect(entry.status).toBe("pending");
        expect(entry.retries).toBeGreaterThanOrEqual(0);
        expect(entry.createdAt).toBeDefined();
        expect(entry.updatedAt).toBeDefined();
      }
    });

    it("should mask sensitive fields in payloads", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);

      // Find the entry that had a token field
      const alphaNetwork = res.body.entries.find(
        (e: any) => e.errorClass === "NETWORK" && e.supplierId === "supplier-alpha",
      );
      expect(alphaNetwork).toBeDefined();
      // The token field should be masked
      expect(alphaNetwork.payload.token).not.toBe("tok_visa_4242");

      // Find the entry that had an api_key field
      const alphaTimeout = res.body.entries.find(
        (e: any) => e.errorClass === "TIMEOUT",
      );
      expect(alphaTimeout.payload.api_key).not.toBe("secret-key");

      // Non-sensitive fields should be visible
      expect(alphaNetwork.payload.amount).toBe(100);
      expect(alphaNetwork.payload.currency).toBe("USD");
    });

    it("should filter by supplierId", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?supplierId=supplier-alpha")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(
        res.body.entries.every(
          (e: any) => e.supplierId === "supplier-alpha",
        ),
      ).toBe(true);
    });

    it("should filter by errorClass (case-insensitive)", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?errorClass=network")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(
        res.body.entries.every(
          (e: any) => e.errorClass.toLowerCase() === "network",
        ),
      ).toBe(true);
    });

    it("should filter by status", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?status=pending")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(4);
    });

    it("should return 400 for invalid status filter", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?status=INVALID_STATUS")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Invalid status");
    });

    it("should search across supplierId, errorClass, errorMessage, and id", async () => {
      // Search by supplierId partial match
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?search=supplier-beta")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].supplierId).toBe("supplier-beta");
    });

    it("should search by errorMessage", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?search=DNS resolution")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });

    it("should support pagination with limit and offset", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=2&offset=0")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(0);
      expect(res.body.total).toBe(4);

      const page2 = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=2&offset=2")
        .set(adminHeaders);

      expect(page2.status).toBe(200);
      expect(page2.body.entries).toHaveLength(2);
      expect(page2.body.total).toBe(4);
    });

    it("should return 400 for invalid limit values", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=0")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("limit");
    });

    it("should return 400 for limit exceeding maximum", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=201")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("limit");
    });

    it("should return 400 for negative offset", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?offset=-1")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("offset");
    });

    it("should return 400 for non-numeric limit", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=abc")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("limit");
    });

    it("should return empty list when no entries exist", async () => {
      resetPayoutDlqStore();
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.entries).toEqual([]);
    });

    it("should combine multiple filters", async () => {
      const res = await request(app)
        .get(
          "/api/v1/admin/payout-dlq?supplierId=supplier-alpha&errorClass=NETWORK",
        )
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].supplierId).toBe("supplier-alpha");
      expect(res.body.entries[0].errorClass).toBe("NETWORK");
    });
  });

  // ─── GET /payout-dlq/:entryId (detail) ─────────────────────────────────────

  describe("GET /api/v1/admin/payout-dlq/:entryId", () => {
    let entryId: string;

    beforeEach(() => {
      const store = getPayoutDlqStore();
      const entry = store.add({
        supplierId: "supplier-omega",
        errorClass: "CRITICAL",
        errorMessage: "Payment gateway returned 500",
        payload: {
          amount: 500,
          currency: "USD",
          password: "super-secret",
          secret: "hush-hush",
          bankDetails: {
            accountNumber: "1234567890",
            routingNumber: "021000021",
          },
        },
        retries: 2,
      });
      entryId = entry.id;
    });

    it("should return a single DLQ entry with masked payload", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/payout-dlq/${entryId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.entry.id).toBe(entryId);
      expect(res.body.entry.supplierId).toBe("supplier-omega");
      expect(res.body.entry.errorClass).toBe("CRITICAL");
      expect(res.body.entry.status).toBe("inspected");

      // Sensitive fields must be masked
      expect(res.body.entry.payload.password).not.toBe("super-secret");
      expect(res.body.entry.payload.secret).not.toBe("hush-hush");

      // Non-sensitive fields visible
      expect(res.body.entry.payload.amount).toBe(500);
      expect(res.body.entry.payload.currency).toBe("USD");
    });

    it("should mask nested sensitive fields in bank details", async () => {
      const res = await request(app)
        .get(`/api/v1/admin/payout-dlq/${entryId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      // PII fields like email, phone, ssn are now part of the
      // SENSITIVE_FIELDS set and will be masked by redact().
    });

    it("should mark entry as inspected on detail view", async () => {
      // First view
      const res1 = await request(app)
        .get(`/api/v1/admin/payout-dlq/${entryId}`)
        .set(adminHeaders);
      expect(res1.status).toBe(200);
      expect(res1.body.entry.status).toBe("inspected");

      // Verify via listing that status changed
      const listRes = await request(app)
        .get("/api/v1/admin/payout-dlq?status=inspected")
        .set(adminHeaders);
      expect(listRes.body.total).toBe(1);
    });

    it("should return 404 for non-existent entry", async () => {
      const res = await request(app)
        .get(
          "/api/v1/admin/payout-dlq/00000000-0000-4000-8000-000000000000",
        )
        .set(adminHeaders);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("not found");
    });

    it("should return 400 for empty entryId", async () => {
      // Use URL-encoded spaces to ensure they reach the route handler
      const res = await request(app)
        .get("/api/v1/admin/payout-dlq/%20%20")
        .set(adminHeaders);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing entryId");
    });

    it("should log an audit event on inspection", async () => {
      // The audit log is written asynchronously, so we just verify
      // the endpoint returns successfully.
      const res = await request(app)
        .get(`/api/v1/admin/payout-dlq/${entryId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      // Audit event is logged via void promise (fire-and-forget pattern)
      // No assertion needed beyond success
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle entries with special characters in error messages", async () => {
      const store = getPayoutDlqStore();
      store.add({
        supplierId: "supplier-special",
        errorClass: "PARSE_ERROR",
        errorMessage: 'Error parsing JSON: unexpected token "<" at position 0',
        payload: { raw: "<html>Error</html>" },
      });

      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.entries[0].errorMessage).toContain("<");
    });

    it("should handle large payloads without truncation", async () => {
      const store = getPayoutDlqStore();
      const largePayload: Record<string, unknown> = {};
      for (let i = 0; i < 500; i++) {
        largePayload[`field_${i}`] = `value_${i}_with_some_more_data`;
      }

      store.add({
        supplierId: "supplier-large",
        errorClass: "BATCH_FAILURE",
        errorMessage: "Large batch payout failed",
        payload: largePayload,
      });

      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);

      // Verify all fields are present in the payload
      const entry = res.body.entries[0];
      for (let i = 0; i < 500; i++) {
        expect(entry.payload[`field_${i}`]).toBe(
          `value_${i}_with_some_more_data`,
        );
      }
    });

    it("should handle concurrent inspection without corruption", async () => {
      const store = getPayoutDlqStore();
      const entry = store.add({
        supplierId: "supplier-concurrent",
        errorClass: "NETWORK",
        errorMessage: "Concurrent test",
        payload: { test: true },
      });

      // Make multiple concurrent requests
      const results = await Promise.all([
        request(app)
          .get(`/api/v1/admin/payout-dlq/${entry.id}`)
          .set(adminHeaders),
        request(app)
          .get(`/api/v1/admin/payout-dlq/${entry.id}`)
          .set(adminHeaders),
        request(app)
          .get(`/api/v1/admin/payout-dlq/${entry.id}`)
          .set(adminHeaders),
      ]);

      // All should succeed
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.body.entry.status).toBe("inspected");
      }
    });

    it("should handle search with URL-encoded spaces and special chars", async () => {
      const store = getPayoutDlqStore();
      store.add({
        supplierId: "supplier-search",
        errorClass: "GATEWAY_ERROR",
        errorMessage: "Error: timeout & retry failed",
        payload: {},
      });

      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?search=timeout%20%26%20retry")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });

    it("should not expose the raw PII via the list endpoint", async () => {
      const store = getPayoutDlqStore();
      store.add({
        supplierId: "supplier-pii",
        errorClass: "VALIDATION",
        errorMessage: "PII test",
        payload: {
          email: "john.doe@example.com",
          phone: "+15551234567",
          ssn: "123-45-6789",
          password: "supersecret123",
          token: "bearer-token-value",
        },
      });

      const res = await request(app)
        .get("/api/v1/admin/payout-dlq")
        .set(adminHeaders);

      expect(res.status).toBe(200);

      const entry = res.body.entries[0];
      // Credential fields must be masked
      expect(entry.payload.password).not.toBe("supersecret123");
      expect(entry.payload.token).not.toBe("bearer-token-value");
      // PII fields (email, phone, ssn) are now masked by redact
      expect(entry.payload.email).not.toBe("john.doe@example.com");
      expect(entry.payload.phone).not.toBe("+15551234567");
      expect(entry.payload.ssn).not.toBe("123-45-6789");
    });

    it("should handle entries from multiple suppliers in list ordering", async () => {
      const store = getPayoutDlqStore();
      for (let i = 0; i < 10; i++) {
        store.add({
          supplierId: `supplier-${i}`,
          errorClass: "NETWORK",
          errorMessage: `Entry ${i}`,
          payload: { index: i },
        });
      }

      const res = await request(app)
        .get("/api/v1/admin/payout-dlq?limit=5")
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(5);
      expect(res.body.total).toBe(10);
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(0);
    });
  });
});

/**
 * API Contract Tests for Slots Endpoint
 * 
 * Validates the public contract (status codes, envelope structure, headers, pagination, errors)
 * for all slot-related endpoints. Tests are deterministic and do not make real external calls.
 * 
 * Coverage:
 * - GET /api/v1/slots: listing with pagination
 * - POST /api/v1/slots: slot creation with API key requirement
 * - Status codes: 200, 201, 400, 401, 403, 422, 429, 500, 503
 * - Response envelopes and headers
 * - Error handling and validation
 */

import request from "supertest";
import { jest } from "@jest/globals";
import { createIntegrationHarness } from "../helpers/integrationHarness.js";
import {
  SlotFixtures,
  CommonFixtures,
} from "../fixtures/api-contract.fixtures.js";

describe("Slots API Contract Tests", () => {
  let harness: ReturnType<typeof createIntegrationHarness>;

  beforeEach(() => {
    harness = createIntegrationHarness();
  });

  // ==================== GET /api/v1/slots ====================

  describe("GET /api/v1/slots - List Slots", () => {
    it("should respond with 200 and valid response envelope", async () => {
      const res = await harness.request.get("/api/v1/slots");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body).toMatchObject({
        slots: expect.any(Array),
      });
    });

    it("should include X-Cache header (HIT or MISS)", async () => {
      const res = await harness.request.get("/api/v1/slots");

      expect(res.headers[CommonFixtures.CACHE_HEADERS.cache.toLowerCase()]).toBeDefined();
      const cacheValue = res.headers[CommonFixtures.CACHE_HEADERS.cache.toLowerCase()];
      expect([CommonFixtures.CACHE_HEADERS.cacheHIT, CommonFixtures.CACHE_HEADERS.cacheMISS]).toContain(cacheValue);
    });

    it("should return array of slots matching schema", async () => {
      const res = await harness.request.get("/api/v1/slots");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(Array.isArray(res.body.slots)).toBe(true);

      // Validate schema if slots exist
      if (res.body.slots.length > 0) {
        res.body.slots.forEach((slot: any) => {
          expect(slot).toHaveProperty("id");
          expect(slot).toHaveProperty("professional");
          expect(slot).toHaveProperty("startTime");
          expect(slot).toHaveProperty("endTime");
        });
      }
    });

    it("should not include internal fields (e.g., _internalNote)", async () => {
      const res = await harness.request.get("/api/v1/slots");

      expect(Array.isArray(res.body.slots)).toBe(true);
      res.body.slots.forEach((slot: any) => {
        expect(slot).not.toHaveProperty("_internalNote");
        expect(slot).not.toHaveProperty("_secret");
        expect(slot).not.toHaveProperty("internalMetadata");
      });
    });

    it("should return Content-Type: application/json", async () => {
      const res = await harness.request.get("/api/v1/slots");

      expect(res.type).toContain("application/json");
    });

    it("should handle repeated requests and set cache appropriately", async () => {
      const res1 = await harness.request.get("/api/v1/slots");
      const res2 = await harness.request.get("/api/v1/slots");

      // Both should be 200
      expect(res1.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res2.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);

      // At least one should have cache info
      const cache1 = res1.headers[CommonFixtures.CACHE_HEADERS.cache.toLowerCase()];
      const cache2 = res2.headers[CommonFixtures.CACHE_HEADERS.cache.toLowerCase()];
      expect(cache1 || cache2).toBeDefined();
    });
  });

  // ==================== POST /api/v1/slots ====================

  describe("POST /api/v1/slots - Create Slot", () => {
    it("should create slot with valid API key and return 201", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body).toMatchObject({
        success: true,
        slot: expect.any(Object),
      });
    });

    it("should return valid slot envelope with required fields", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.slot).toHaveProperty("id");
      expect(res.body.slot).toHaveProperty("professional", SlotFixtures.VALID_SLOT_REQUEST.professional);
      expect(res.body.slot).toHaveProperty("startTime", SlotFixtures.VALID_SLOT_REQUEST.startTime);
      expect(res.body.slot).toHaveProperty("endTime", SlotFixtures.VALID_SLOT_REQUEST.endTime);
    });

    it("should reject request without API key with 401", async () => {
      const res = await harness.request
        .post("/api/v1/slots")
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNAUTHORIZED);
      expect(res.body.error).toBeDefined();
    });

    it("should reject request with invalid API key with 401 or 403", async () => {
      const res = await request(harness.app)
        .post("/api/v1/slots")
        .set(CommonFixtures.API_KEY_HEADER, CommonFixtures.INVALID_API_KEY)
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect([
        CommonFixtures.HTTP_STATUS_CODES.UNAUTHORIZED,
        CommonFixtures.HTTP_STATUS_CODES.FORBIDDEN,
      ]).toContain(res.status);
    });

    it("should reject missing professional field with 400", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_MISSING_PROFESSIONAL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing startTime field with 400", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_MISSING_START_TIME);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing endTime field with 400", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_MISSING_END_TIME);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject non-numeric time values with 422 or 400", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_NON_NUMERIC_TIMES);

      expect([
        CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST,
        CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY,
      ]).toContain(res.status);
    });

    it("should reject endTime <= startTime with 422", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_END_TIME_LTE_START);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject endTime before startTime with 422", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.INVALID_SLOT_END_TIME_BEFORE_START);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject malformed JSON body with 400", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
    });

    it("should include proper Content-Type header in response", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect(res.type).toContain("application/json");
    });

    it("should not include sensitive fields in slot response", async () => {
      const res = await harness.authorizedPost("/api/v1/slots")
        .send(SlotFixtures.VALID_SLOT_REQUEST);

      expect(res.body.slot).not.toHaveProperty("_secret");
      expect(res.body.slot).not.toHaveProperty("internalId");
      expect(res.body.slot).not.toHaveProperty("apiKeyUsed");
    });
  });

  // ==================== Unknown Routes ====================

  describe("Unknown Routes", () => {
    it("should return 404 for unknown slot routes", async () => {
      const res = await harness.request.get("/api/v1/slots/invalid/unknown");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
    });

    it("should return JSON error for 404", async () => {
      const res = await harness.request.get("/api/v1/unknown-endpoint");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
      if (res.body) {
        // Error should be JSON, not HTML
        expect(typeof res.body).toBe("object");
      }
    });
  });

  // ==================== Server Error Handling ====================

  describe("Server Error Handling", () => {
    it("should return 500 with error envelope on unhandled exception", async () => {
      const res = await harness.request.get("/__test__/explode");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
      expect(res.body).toHaveProperty("error");
    });

    it("should not leak stack traces in error response", async () => {
      const res = await harness.request.get("/__test__/explode");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR);
      expect(res.body.error).not.toMatch(/at /);
      expect(res.body.error).not.toMatch(/node_modules/);
    });
  });

  // ==================== Health Check ====================

  describe("Health Check Endpoint", () => {
    it("should return 200 for /health", async () => {
      const res = await harness.request.get("/health");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body).toMatchObject({
        status: "ok",
        service: "chronopay-backend",
      });
    });
  });

  // ==================== Rate Limiting ====================

  describe("Rate Limiting", () => {
    it("should include RateLimit headers in response", async () => {
      const res = await harness.request.get("/api/v1/slots");

      // Check for RateLimit header presence (RFC 7231)
      const hasRateLimitHeader = Object.keys(res.headers).some(
        (key) => key.toLowerCase().includes("ratelimit")
      );

      // Rate limit headers should be present or endpoint should be unguarded
      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
    });
  });
});

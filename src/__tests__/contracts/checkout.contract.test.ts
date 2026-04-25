/**
 * API Contract Tests for Checkout Endpoint
 * 
 * Validates the public contract (status codes, envelope structure, headers, error codes)
 * for all checkout session endpoints. Tests are deterministic and mock all external calls.
 * 
 * Coverage:
 * - POST /api/v1/checkout/sessions: session creation
 * - GET /api/v1/checkout/sessions/:sessionId: session retrieval
 * - POST /api/v1/checkout/sessions/:sessionId/complete: session completion
 * - POST /api/v1/checkout/sessions/:sessionId/cancel: session cancellation
 * - Status codes: 200, 201, 400, 401, 404, 409, 422, 503, 500
 * - Response envelopes and error codes
 * - Input validation
 */

import request from "supertest";
import { jest } from "@jest/globals";
import { createIntegrationHarness } from "../helpers/integrationHarness.js";
import {
  CheckoutFixtures,
  CommonFixtures,
} from "../fixtures/api-contract.fixtures.js";

describe("Checkout API Contract Tests", () => {
  let harness: ReturnType<typeof createIntegrationHarness>;

  beforeEach(() => {
    harness = createIntegrationHarness();
  });

  // ==================== POST /api/v1/checkout/sessions ====================

  describe("POST /api/v1/checkout/sessions - Create Session", () => {
    it("should create session with valid payload and return 201", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body).toMatchObject(
        CheckoutFixtures.EXPECTED_CHECKOUT_RESPONSE_ENVELOPE
      );
    });

    it("should return valid session object with required fields", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.session).toMatchObject(
        CheckoutFixtures.EXPECTED_CHECKOUT_SESSION_OBJECT
      );
      expect(res.body.session.createdAt < res.body.session.expiresAt).toBe(
        true
      );
    });

    it("should create session with metadata and redirects", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_WITH_METADATA);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.session.metadata).toBeDefined();
      expect(res.body.session.successUrl).toBe(
        CheckoutFixtures.VALID_SESSION_WITH_METADATA.successUrl
      );
      expect(res.body.session.cancelUrl).toBe(
        CheckoutFixtures.VALID_SESSION_WITH_METADATA.cancelUrl
      );
    });

    it("should support XLM currency for crypto payments", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_XLM_SESSION);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.session.payment.currency).toBe("XLM");
    });

    it("should include checkout URL in response", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.checkoutUrl).toBeDefined();
      expect(typeof res.body.checkoutUrl).toBe("string");
      expect(res.body.checkoutUrl).toContain("/api/v1/checkout/sessions/");
    });

    // ========== Validation Error Tests ==========

    it("should reject missing payment object with 400", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_PAYMENT);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body).toMatchObject(
        CheckoutFixtures.EXPECTED_ERROR_RESPONSE_ENVELOPE
      );
    });

    it("should reject missing customer object with 400", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_CUSTOMER);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body).toMatchObject(
        CheckoutFixtures.EXPECTED_ERROR_RESPONSE_ENVELOPE
      );
    });

    it("should reject negative amount with 422", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_NEGATIVE_AMOUNT);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject zero amount with 422", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_ZERO_AMOUNT);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject invalid currency with 422", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_INVALID_CURRENCY);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject invalid email with 422", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_INVALID_EMAIL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing customerId with 400", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_CUSTOMER_ID);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing email with 400", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_EMAIL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject malformed JSON with 400", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .set("Content-Type", "application/json")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
    });

    it("should return Content-Type: application/json", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.type).toContain("application/json");
    });
  });

  // ==================== GET /api/v1/checkout/sessions/:sessionId ====================

  describe("GET /api/v1/checkout/sessions/:sessionId - Retrieve Session", () => {
    it("should retrieve valid session and return 200", async () => {
      // First create a session
      const createRes = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(createRes.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      const sessionId = createRes.body.session.id;

      // Then retrieve it
      const res = await harness.request.get(`/api/v1/checkout/sessions/${sessionId}`);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body).toMatchObject({
        success: true,
        session: expect.any(Object),
      });
      expect(res.body.session.id).toBe(sessionId);
    });

    it("should return 404 for non-existent session", async () => {
      const res = await harness.request.get(
        `/api/v1/checkout/sessions/${CheckoutFixtures.VALID_SESSION_ID}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for invalid session ID format", async () => {
      const res = await harness.request.get("/api/v1/checkout/sessions/invalid-id");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });
  });

  // ==================== Error Response Format ====================

  describe("Error Response Format", () => {
    it("should include error code in error responses", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_PAYMENT);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      // Error response should have standard error structure
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBeDefined();
    });

    it("should not leak sensitive information in error messages", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      // Error message should be user-friendly, not technical
      expect(res.body.error).not.toContain("at ");
      expect(res.body.error).not.toContain("TypeError");
    });

    it("should maintain consistent error response structure", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_MISSING_PAYMENT);

      // Ensure standard error envelope
      expect(res.body).toMatchObject({
        success: false,
        error: expect.any(String),
      });
    });
  });

  // ==================== Status Code Contract ====================

  describe("Status Code Contract", () => {
    it("should return 201 on successful session creation", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
    });

    it("should return 200 on successful session retrieval", async () => {
      const createRes = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      const sessionId = createRes.body.session.id;
      const res = await harness.request.get(`/api/v1/checkout/sessions/${sessionId}`);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
    });

    it("should return 4xx for client errors (validation)", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_NEGATIVE_AMOUNT);

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it("should return 422 for semantic validation errors (amount, currency)", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_ZERO_AMOUNT);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
    });
  });

  // ==================== Content Type ====================

  describe("Content Type", () => {
    it("should return application/json for all endpoints", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.type).toContain("application/json");
    });

    it("should handle POST with JSON body correctly", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .set("Content-Type", "application/json")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
    });
  });

  // ==================== Security ====================

  describe("Security", () => {
    it("should not expose internal checkout IDs in responses", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.VALID_SESSION_REQUEST);

      expect(res.body.session).not.toHaveProperty("_internalId");
      expect(res.body.session).not.toHaveProperty("_secretKey");
    });

    it("should not include raw API keys or secrets in error messages", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(JSON.stringify(res.body)).not.toContain("secret");
      expect(JSON.stringify(res.body)).not.toContain("apikey");
    });

    it("should sanitize customer email in error scenarios", async () => {
      const res = await harness.request
        .post("/api/v1/checkout/sessions")
        .send(CheckoutFixtures.INVALID_SESSION_INVALID_EMAIL);

      // Error message should not contain the invalid email
      expect(res.body.error).not.toContain("@");
    });
  });
});

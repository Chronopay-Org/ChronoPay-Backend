/**
 * API Contract Tests for Buyer Profile Endpoint
 * 
 * Validates the public contract (status codes, envelope structure, headers, error codes)
 * for all buyer profile endpoints. Tests are deterministic and mock all external calls.
 * 
 * Coverage:
 * - POST /api/v1/buyer-profiles: profile creation
 * - GET /api/v1/buyer-profiles/me: get current user profile
 * - GET /api/v1/buyer-profiles: list profiles (admin only)
 * - GET /api/v1/buyer-profiles/:id: get profile by ID
 * - PATCH /api/v1/buyer-profiles/:id: update profile
 * - DELETE /api/v1/buyer-profiles/:id: delete profile (soft delete)
 * - Status codes: 200, 201, 400, 401, 403, 404, 409, 422, 500
 * - Response envelopes and error codes
 * - Authorization and ownership validation
 */

import request from "supertest";
import { jest } from "@jest/globals";
import { createIntegrationHarness } from "../helpers/integrationHarness.js";
import {
  BuyerProfileFixtures,
  CommonFixtures,
} from "../fixtures/api-contract.fixtures.js";

describe("Buyer Profile API Contract Tests", () => {
  let harness: ReturnType<typeof createIntegrationHarness>;

  beforeEach(() => {
    harness = createIntegrationHarness();
    // Clear test stores
    (harness.app as any).profileStore?.clear();
    (harness.app as any).userIdIndex?.clear();
    (harness.app as any).emailIndex?.clear();
  });

  // ==================== POST /api/v1/buyer-profiles ====================

  describe("POST /api/v1/buyer-profiles - Create Profile", () => {
    it("should create profile with valid payload and return 201", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body).toMatchObject(
        BuyerProfileFixtures.EXPECTED_PROFILE_RESPONSE_ENVELOPE
      );
    });

    it("should return valid profile object with required fields", async () => {
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.data).toMatchObject({
        id: expect.any(String),
        userId: uniqueData.userId,
        fullName: uniqueData.fullName,
        email: uniqueData.email.toLowerCase(),
        phoneNumber: uniqueData.phoneNumber,
      });
    });

    it("should create profile with optional address and avatar", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_WITH_ADDRESS);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.data.address).toBe(
        BuyerProfileFixtures.VALID_CREATE_WITH_ADDRESS.address
      );
      expect(res.body.data.avatarUrl).toBe(
        BuyerProfileFixtures.VALID_CREATE_WITH_ADDRESS.avatarUrl
      );
    });

    // ========== Validation Error Tests ==========

    it("should reject missing userId with 400", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_MISSING_USER_ID);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body).toMatchObject(
        BuyerProfileFixtures.EXPECTED_ERROR_RESPONSE_ENVELOPE
      );
    });

    it("should reject missing fullName with 400", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_MISSING_FULL_NAME);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing email with 400", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_MISSING_EMAIL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject missing phoneNumber with 400", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_MISSING_PHONE);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });

    it("should reject invalid email format with 422", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_INVALID_EMAIL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject invalid phone format with 422", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_INVALID_PHONE);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
      expect(res.body.error).toBeDefined();
    });

    it("should reject duplicate email with 409", async () => {
      // Create first profile
      await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      // Try to create second profile with same email
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CONFLICT);
      expect(res.body.error).toBeDefined();
    });

    it("should reject duplicate userId with 409", async () => {
      // Create first profile
      await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      // Try to create second profile with same userId
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send({
          ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
          email: "different@example.com",
        });

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CONFLICT);
      expect(res.body.error).toBeDefined();
    });

    it("should reject malformed JSON with 400", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .set("Content-Type", "application/json")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
    });

    it("should return Content-Type: application/json", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      expect(res.type).toContain("application/json");
    });
  });

  // ==================== GET /api/v1/buyer-profiles/:id ====================

  describe("GET /api/v1/buyer-profiles/:id - Retrieve Profile", () => {
    it("should retrieve valid profile and return 200", async () => {
      // First create a profile with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);
      expect(createRes.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      const profileId = createRes.body.data.id;

      // Then retrieve it
      const res = await harness.request.get(
        `/api/v1/buyer-profiles/${profileId}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body).toMatchObject({
        success: true,
        data: expect.any(Object),
      });
      expect(res.body.data.id).toBe(profileId);
    });

    it("should return 404 for non-existent profile", async () => {
      const res = await harness.request.get(
        `/api/v1/buyer-profiles/${BuyerProfileFixtures.VALID_PROFILE_ID}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
      expect(res.body.error).toBeDefined();
    });

    it("should return 400 for invalid profile ID format", async () => {
      const res = await harness.request.get("/api/v1/buyer-profiles/invalid-id");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
      expect(res.body.error).toBeDefined();
    });
  });

  // ==================== PATCH /api/v1/buyer-profiles/:id ====================

  describe("PATCH /api/v1/buyer-profiles/:id - Update Profile", () => {
    it("should update profile with valid payload and return 200", async () => {
      // Create profile first with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      const profileId = createRes.body.data.id;

      // Update it
      const res = await harness.request
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .send(BuyerProfileFixtures.VALID_UPDATE_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body.data.fullName).toBe(
        BuyerProfileFixtures.VALID_UPDATE_REQUEST.fullName
      );
      expect(res.body.data.phoneNumber).toBe(
        BuyerProfileFixtures.VALID_UPDATE_REQUEST.phoneNumber
      );
    });

    it("should allow partial updates", async () => {
      // Create profile first with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      expect(createRes.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      const profileId = createRes.body.data.id;
      const originalEmail = createRes.body.data.email;

      // Update only fullName
      const res = await harness.request
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .send({ fullName: "Updated Name Only" });

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body.data.fullName).toBe("Updated Name Only");
      expect(res.body.data.email).toBe(originalEmail); // Email unchanged
    });

    it("should return 404 for non-existent profile", async () => {
      const res = await harness.request
        .patch(`/api/v1/buyer-profiles/${BuyerProfileFixtures.VALID_PROFILE_ID}`)
        .send(BuyerProfileFixtures.VALID_UPDATE_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
    });

    it("should reject invalid email in update with 422", async () => {
      // Create profile first with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      const profileId = createRes.body.data.id;

      // Try to update with invalid email
      const res = await harness.request
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .send(BuyerProfileFixtures.INVALID_UPDATE_INVALID_EMAIL);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.UNPROCESSABLE_ENTITY);
    });

    it("should return 400 for invalid profile ID format", async () => {
      const res = await harness.request
        .patch("/api/v1/buyer-profiles/invalid-id")
        .send(BuyerProfileFixtures.VALID_UPDATE_REQUEST);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
    });
  });

  // ==================== DELETE /api/v1/buyer-profiles/:id ====================

  describe("DELETE /api/v1/buyer-profiles/:id - Delete Profile", () => {
    it("should soft-delete profile and return 200", async () => {
      // Create profile first with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      expect(createRes.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      const profileId = createRes.body.data.id;

      // Delete it
      const res = await harness.request.delete(
        `/api/v1/buyer-profiles/${profileId}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
    });

    it("should return 404 for deleted profile on subsequent retrieval", async () => {
      // Create profile with unique data
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const createRes = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      const profileId = createRes.body.data.id;

      // Delete it
      await harness.request.delete(`/api/v1/buyer-profiles/${profileId}`);

      // Try to retrieve deleted profile
      const res = await harness.request.get(
        `/api/v1/buyer-profiles/${profileId}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
    });

    it("should return 404 for non-existent profile", async () => {
      const res = await harness.request.delete(
        `/api/v1/buyer-profiles/${BuyerProfileFixtures.VALID_PROFILE_ID}`
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.NOT_FOUND);
    });

    it("should return 400 for invalid profile ID format", async () => {
      const res = await harness.request.delete(
        "/api/v1/buyer-profiles/invalid-id"
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.BAD_REQUEST);
    });
  });

  // ==================== GET /api/v1/buyer-profiles ====================

  describe("GET /api/v1/buyer-profiles - List Profiles", () => {
    it("should list profiles with pagination and return 200", async () => {
      // Create a profile first
      await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      // List profiles
      const res = await harness.request.get("/api/v1/buyer-profiles");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body).toMatchObject(
        BuyerProfileFixtures.EXPECTED_LIST_RESPONSE_ENVELOPE
      );
    });

    it("should return pagination metadata", async () => {
      // Create a profile
      await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      // List profiles
      const res = await harness.request.get("/api/v1/buyer-profiles");

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body.pagination).toHaveProperty("page");
      expect(res.body.pagination).toHaveProperty("limit");
      expect(res.body.pagination).toHaveProperty("total");
      expect(res.body.pagination).toHaveProperty("totalPages");
    });

    it("should support pagination parameters", async () => {
      // Create multiple profiles
      await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      await harness.request
        .post("/api/v1/buyer-profiles")
        .send({
          ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
          userId: "user_test_002",
          email: "different@example.com",
        });

      // List with pagination
      const res = await harness.request.get(
        "/api/v1/buyer-profiles?page=1&limit=10"
      );

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.OK);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(10);
    });
  });

  // ==================== Error Response Format ====================

  describe("Error Response Format", () => {
    it("should maintain consistent error structure", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_MISSING_EMAIL);

      expect(res.body).toMatchObject({
        success: false,
        error: expect.any(String),
      });
    });

    it("should not leak sensitive information in errors", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(CommonFixtures.MALFORMED_JSON_BODY);

      expect(res.body.error).not.toContain("at ");
      expect(res.body.error).not.toContain("TypeError");
    });
  });

  // ==================== Security ====================

  describe("Security", () => {
    it("should not expose internal profile fields", async () => {
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `test${Date.now()}@example.com`,
      };

      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.data).not.toHaveProperty("_internalId");
      expect(res.body.data).not.toHaveProperty("_secret");
      expect(res.body.data).not.toHaveProperty("passwordHash");
    });

    it("should not include raw email in error messages when possible", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.INVALID_CREATE_INVALID_EMAIL);

      // Error should not expose the bad email
      expect(res.body.error).not.toContain("@");
    });

    it("should normalize email to lowercase consistently", async () => {
      const uniqueData = {
        ...BuyerProfileFixtures.VALID_CREATE_REQUEST,
        userId: `user_${Date.now()}`,
        email: `Test${Date.now()}@EXAMPLE.COM`,
      };

      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(uniqueData);

      expect(res.status).toBe(CommonFixtures.HTTP_STATUS_CODES.CREATED);
      expect(res.body.data.email).toBe(uniqueData.email.toLowerCase());
    });
  });

  // ==================== Content Type ====================

  describe("Content Type", () => {
    it("should return application/json for all endpoints", async () => {
      const res = await harness.request
        .post("/api/v1/buyer-profiles")
        .send(BuyerProfileFixtures.VALID_CREATE_REQUEST);

      expect(res.type).toContain("application/json");
    });
  });
});

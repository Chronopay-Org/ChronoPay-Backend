/**
 * Buyer Profile Controller Integration Tests
 * 
 * Tests all HTTP endpoints for Buyer Profile operations.
 * Uses supertest for HTTP request testing.
 */

import request from "supertest";
import app from "../../index.js";
import { buyerProfileService } from "../buyer-profile.service.js";
import { addMockUser, clearMockUsers, UserRole } from "../../middleware/auth.middleware.js";

describe.skip("BuyerProfileController", () => {
  // Setup mock users and clear profiles before each test
  beforeEach(async () => {
    await buyerProfileService.clearAll();
    clearMockUsers();

    // Add test users
    addMockUser({
      id: "user-1",
      email: "user1@example.com",
      role: UserRole.USER,
    });

    addMockUser({
      id: "user-2",
      email: "user2@example.com",
      role: UserRole.USER,
    });

    addMockUser({
      id: "admin-1",
      email: "admin@example.com",
      role: UserRole.ADMIN,
    });
  });

  describe("POST /api/v1/buyer-profiles", () => {
    const validProfileData = {
      fullName: "John Doe",
      email: "john.doe@example.com",
      phoneNumber: "+1234567890",
      address: "123 Main St, City, Country",
      avatarUrl: "https://example.com/avatar.jpg",
    };

    it("should create a profile successfully", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send(validProfileData);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.userId).toBe("user-1");
      expect(res.body.data.fullName).toBe(validProfileData.fullName);
      expect(res.body.data.email).toBe(validProfileData.email);
      expect(res.body.message).toBe("Buyer profile created successfully");
    });

    it("should return 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .send(validProfileData);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Authentication required");
    });

    it("should return 400 when required fields are missing", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          // missing email and phoneNumber
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Validation failed");
      expect(res.body.details).toBeDefined();
    });

    it("should return 400 when email format is invalid", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          ...validProfileData,
          email: "invalid-email",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.details).toContainEqual(
        expect.objectContaining({ field: "email" })
      );
    });

    it("should return 400 when phone number format is invalid", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          ...validProfileData,
          phoneNumber: "123", // too short
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.details).toContainEqual(
        expect.objectContaining({ field: "phoneNumber" })
      );
    });

    it("should return 409 when user already has a profile", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send(validProfileData);

      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          ...validProfileData,
          email: "different@example.com",
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Conflict");
    });

    it("should return 409 when email is already in use", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send(validProfileData);

      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-2")
        .send(validProfileData);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Conflict");
    });

    it("should create profile with optional fields omitted", async () => {
      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.address).toBeUndefined();
      expect(res.body.data.avatarUrl).toBeUndefined();
    });
  });

  describe("GET /api/v1/buyer-profiles/me", () => {
    it("should return current user's profile", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      const res = await request(app)
        .get("/api/v1/buyer-profiles/me")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.userId).toBe("user-1");
    });

    it("should return 401 when not authenticated", async () => {
      const res = await request(app).get("/api/v1/buyer-profiles/me");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should return 404 when user has no profile", async () => {
      const res = await request(app)
        .get("/api/v1/buyer-profiles/me")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Not found");
    });
  });

  describe("GET /api/v1/buyer-profiles/:id", () => {
    it("should return profile by ID for owner", async () => {
      const createRes = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      const profileId = createRes.body.data.id;

      const res = await request(app)
        .get(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(profileId);
    });

    it("should return profile by ID for admin", async () => {
      const createRes = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      const profileId = createRes.body.data.id;

      const res = await request(app)
        .get(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer admin-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 403 when non-admin tries to view another user's profile", async () => {
      const createRes = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      const profileId = createRes.body.data.id;

      const res = await request(app)
        .get(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-2");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Access denied");
    });

    it("should return 404 when profile not found", async () => {
      const res = await request(app)
        .get("/api/v1/buyer-profiles/00000000-0000-0000-0000-000000000000")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("should return 400 when ID format is invalid", async () => {
      const res = await request(app)
        .get("/api/v1/buyer-profiles/invalid-id")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Validation failed");
    });
  });

  describe("GET /api/v1/buyer-profiles", () => {
    it("should return all profiles for admin", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-2")
        .send({
          fullName: "Jane Smith",
          email: "jane.smith@example.com",
          phoneNumber: "+0987654321",
        });

      const res = await request(app)
        .get("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer admin-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toBeDefined();
    });

    it("should return 403 when non-admin tries to list profiles", async () => {
      const res = await request(app)
        .get("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Insufficient permissions");
    });

    it("should support pagination", async () => {
      // Create 2 profiles (we only have user-1 and user-2 in mock users)
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "User 1",
          email: "user1@example.com",
          phoneNumber: "+1234567891",
        });

      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-2")
        .send({
          fullName: "User 2",
          email: "user2@example.com",
          phoneNumber: "+1234567892",
        });

      const res = await request(app)
        .get("/api/v1/buyer-profiles?page=1&limit=2")
        .set("Authorization", "Bearer admin-1");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(2);
      expect(res.body.pagination.total).toBe(2);
      expect(res.body.pagination.totalPages).toBe(1);
    });

    it("should support filtering by userId", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      const res = await request(app)
        .get("/api/v1/buyer-profiles?userId=user-1")
        .set("Authorization", "Bearer admin-1");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userId).toBe("user-1");
    });
  });

  describe("PATCH /api/v1/buyer-profiles/:id", () => {
    let profileId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      profileId = createRes.body.data.id;
    });

    it("should update profile successfully for owner", async () => {
      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Updated",
          phoneNumber: "+9999999999",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fullName).toBe("John Updated");
      expect(res.body.data.phoneNumber).toBe("+9999999999");
      expect(res.body.message).toBe("Profile updated successfully");
    });

    it("should update profile successfully for admin", async () => {
      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer admin-1")
        .send({
          fullName: "John Updated by Admin",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.fullName).toBe("John Updated by Admin");
    });

    it("should return 403 when non-owner tries to update", async () => {
      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-2")
        .send({
          fullName: "Hacked",
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Access denied");
    });

    it("should return 400 when no fields are provided", async () => {
      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Validation failed");
    });

    it("should return 400 when email format is invalid", async () => {
      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1")
        .send({
          email: "invalid-email",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("should return 409 when email is already in use", async () => {
      await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-2")
        .send({
          fullName: "Jane Smith",
          email: "jane.smith@example.com",
          phoneNumber: "+0987654321",
        });

      const res = await request(app)
        .patch(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1")
        .send({
          email: "jane.smith@example.com",
        });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Conflict");
    });

    it("should return 404 when profile not found", async () => {
      const res = await request(app)
        .patch("/api/v1/buyer-profiles/00000000-0000-0000-0000-000000000000")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "Test",
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("DELETE /api/v1/buyer-profiles/:id", () => {
    let profileId: string;

    beforeEach(async () => {
      const createRes = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John Doe",
          email: "john.doe@example.com",
          phoneNumber: "+1234567890",
        });

      profileId = createRes.body.data.id;
    });

    it("should delete profile successfully for owner", async () => {
      const res = await request(app)
        .delete(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Profile deleted successfully");

      // Verify profile is deleted
      const getRes = await request(app)
        .get(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1");

      expect(getRes.status).toBe(404);
    });

    it("should delete profile successfully for admin", async () => {
      const res = await request(app)
        .delete(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer admin-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("should return 403 when non-owner tries to delete", async () => {
      const res = await request(app)
        .delete(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-2");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe("Access denied");
    });

    it("should return 404 when profile not found", async () => {
      const res = await request(app)
        .delete("/api/v1/buyer-profiles/00000000-0000-0000-0000-000000000000")
        .set("Authorization", "Bearer user-1");

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("should allow creating new profile after deletion", async () => {
      await request(app)
        .delete(`/api/v1/buyer-profiles/${profileId}`)
        .set("Authorization", "Bearer user-1");

      const res = await request(app)
        .post("/api/v1/buyer-profiles")
        .set("Authorization", "Bearer user-1")
        .send({
          fullName: "John New",
          email: "john.new@example.com",
          phoneNumber: "+9999999999",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });
});

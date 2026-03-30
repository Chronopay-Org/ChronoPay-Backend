import request from "supertest";
import app from "../index.js";

describe("RBAC and validation middleware edge cases", () => {
  describe("RBAC edge cases", () => {
    it("should handle null role header gracefully", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Missing required authentication header");
    });

    it("should handle whitespace-only role header", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "   ")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should handle numeric-like invalid role", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "123")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid user role");
    });

    it("should handle mixed-case valid role (normalization test)", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "ADMIN")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("should handle customer role denied", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "customer")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: 2000,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Insufficient permissions");
    });
  });

  describe("Validation middleware edge cases", () => {
    it("should reject request body that is empty object", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "professional")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("should enforce all required fields as mandatory", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "professional")
        .send({ professional: "alice" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Missing required field");
    });

    it("should reject when one critical field is null", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "professional")
        .send({
          professional: "alice",
          startTime: null,
          endTime: 2000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required field: startTime");
    });

    it("should reject when a field is explicitly undefined", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "professional")
        .send({
          professional: "alice",
          startTime: 1000,
          endTime: undefined,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required field: endTime");
    });

    it("should allow valid zero value for numeric field", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "professional")
        .send({
          professional: "alice",
          startTime: 0,
          endTime: 1000,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Authorization before validation order", () => {
    it("should check authorization before validating fields", async () => {
      const res = await request(app)
        .post("/api/v1/slots")
        .set("x-user-role", "customer")
        .send({
          // missing all required fields
        });

      // Should fail on authorization first, not validation
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Insufficient permissions");
    });
  });

  describe("Health endpoint access", () => {
    it("should allow health check without auth header", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("Slots list endpoint access", () => {
    it("should allow slot list without auth header", async () => {
      const res = await request(app).get("/api/v1/slots");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.slots)).toBe(true);
    });
  });
});

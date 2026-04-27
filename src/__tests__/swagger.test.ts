import request from "supertest";
import app from "../index.js";

describe.skip("OpenAPI Documentation", () => {
  it("should serve the swagger UI at /api-docs/", async () => {
    const response = await request(app).get("/api-docs/");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Swagger UI");
  });

  it("should serve the swagger JSON at /api-docs-json (if configured) or verify JSON structure in /api-docs", async () => {
    // swagger-jsdoc doesn't automatically create a JSON endpoint unless we do it.
    // Let's check if the index.ts setup works for the UI.
    const response = await request(app).get("/api-docs/");
    expect(response.status).toBe(200);
  });

  describe("Security Schemes", () => {
    it("should include security schemes in OpenAPI spec", async () => {
      // Test by checking the swagger UI HTML contains references to security
      const response = await request(app).get("/api-docs/");
      expect(response.text).toContain("bearerAuth");
      expect(response.text).toContain("chronoPayAuth");
      expect(response.text).toContain("apiKeyAuth");
      expect(response.text).toContain("adminTokenAuth");
    });

    it("should include error response schemas", async () => {
      const response = await request(app).get("/api-docs/");
      expect(response.text).toContain("ErrorEnvelope");
      expect(response.text).toContain("UnauthorizedError");
      expect(response.text).toContain("ForbiddenError");
    });
  });

  describe("Authentication Error Responses", () => {
    it("should return 401 for missing API key on protected endpoint", async () => {
      const response = await request(app)
        .post("/api/v1/slots")
        .send({
          professional: "test-professional",
          startTime: "2024-01-01T10:00:00Z",
          endTime: "2024-01-01T11:00:00Z"
        });
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });

    it("should return 401 for missing user headers on auth endpoint", async () => {
      const response = await request(app)
        .get("/api/v1/slots");
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });

    it("should return 403 for invalid API key", async () => {
      const response = await request(app)
        .post("/api/v1/slots")
        .set("x-api-key", "invalid-key")
        .send({
          professional: "test-professional", 
          startTime: "2024-01-01T10:00:00Z",
          endTime: "2024-01-01T11:00:00Z"
        });
      
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });

    it("should return 403 for insufficient role permissions", async () => {
      const response = await request(app)
        .get("/api/v1/slots")
        .set("x-chronopay-user-id", "test-user")
        .set("x-chronopay-role", "unauthorized-role");
      
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });
  });

  describe("Checkout Authentication", () => {
    it("should allow creating checkout session without auth (optional)", async () => {
      const response = await request(app)
        .post("/api/v1/checkout/sessions")
        .send({
          payment: {
            amount: 1000,
            currency: "USD",
            paymentMethod: "credit_card"
          },
          customer: {
            customerId: "test-customer-123",
            email: "test@example.com"
          }
        });
      
      // Should either succeed (201) or fail due to validation, but not auth
      expect([201, 400]).toContain(response.status);
      if (response.status === 400) {
        expect(response.body).toHaveProperty("success", false);
        // Should not be an auth error
        expect(response.body.error).not.toMatch(/authentication|authorization/i);
      }
    });

    it("should accept optional auth headers for checkout", async () => {
      const response = await request(app)
        .post("/api/v1/checkout/sessions")
        .set("x-chronopay-user-id", "test-user")
        .set("x-chronopay-role", "customer")
        .set("Authorization", "Bearer test-token")
        .send({
          payment: {
            amount: 1000,
            currency: "USD", 
            paymentMethod: "credit_card"
          },
          customer: {
            customerId: "test-customer-123",
            email: "test@example.com"
          }
        });
      
      // Should either succeed (201) or fail due to validation, but not auth
      expect([201, 400]).toContain(response.status);
    });
  });

  describe("Security Headers and Best Practices", () => {
    it("should not expose sensitive information in error messages", async () => {
      const response = await request(app)
        .post("/api/v1/slots")
        .set("x-api-key", "wrong-key")
        .send({
          professional: "test-professional",
          startTime: "2024-01-01T10:00:00Z", 
          endTime: "2024-01-01T11:00:00Z"
        });
      
      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty("success", false);
      // Error message should be generic, not expose system details
      expect(response.body.error).not.toContain("password");
      expect(response.body.error).not.toContain("secret");
      expect(response.body.error).not.toContain("database");
    });

    it("should handle malformed auth headers gracefully", async () => {
      const response = await request(app)
        .get("/api/v1/slots")
        .set("x-chronopay-user-id", "")
        .set("x-chronopay-role", "customer");
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("success", false);
      expect(response.body).toHaveProperty("error");
    });
  });
});

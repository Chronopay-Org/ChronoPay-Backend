import request from "supertest";
import app from "../index.js";

describe("Docker Health Check", () => {
  describe("GET /health", () => {
    it("should return healthy status for container health checks", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("service", "chronopay-backend");
    });

    it("should respond within health check timeout (10s)", async () => {
      const start = Date.now();
      const response = await request(app).get("/health");
      const duration = Date.now() - start;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(10000);
    });

    it("should return JSON content type", async () => {
      const response = await request(app).get("/health");

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
    });
  });

  describe("Environment Configuration", () => {
    it("should have NODE_ENV defined", () => {
      expect(process.env.NODE_ENV).toBeDefined();
    });

    it("should have PORT defined with default fallback", () => {
      const port = process.env.PORT ?? "3001";
      expect(port).toMatch(/^\d+$/);
      expect(parseInt(port, 10)).toBeGreaterThan(0);
      expect(parseInt(port, 10)).toBeLessThanOrEqual(65535);
    });
  });

  describe("Container Readiness", () => {
    it("should handle concurrent health check requests", async () => {
      const requests = Array(10).fill(null).map(() =>
        request(app).get("/health")
      );

      const responses = await Promise.all(requests);

      responses.forEach((response) => {
        expect(response.status).toBe(200);
        expect(response.body.status).toBe("ok");
      });
    });

    it("should handle health check under load", async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(request(app).get("/health"));
      }

      const results = await Promise.all(promises);
      const successCount = results.filter(r => r.status === 200).length;

      expect(successCount).toBe(50);
    });
  });
});

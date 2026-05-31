import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import authRouter from "../auth.js";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";

describe("auth routes", () => {
  describe("POST /api/v1/auth/verify", () => {
    let app: express.Express;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use("/api/v1/auth", authRouter);
    });

    beforeEach(() => {
      process.env.JWT_SECRET = "primary-secret-key-12345";
      process.env.JWT_SECRET_PREV = "retired-secret-key-67890";
      process.env.JWT_ISSUER = "test-issuer";
      process.env.JWT_AUDIENCE = "test-audience";
      configService.refresh();
    });

    afterEach(() => {
      delete process.env.JWT_SECRET;
      delete process.env.JWT_SECRET_PREV;
      delete process.env.JWT_ISSUER;
      delete process.env.JWT_AUDIENCE;
      configService.refresh();
      jest.restoreAllMocks();
    });

    it("returns 200 with subject and expiresAt for a valid token", async () => {
      const validToken = await signJwt(
        { sub: "user-123", role: "customer", iat: Math.floor(Date.now() / 1000) },
        "primary-secret-key-12345",
        { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: validToken });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        subject: "user-123",
      });
      expect(typeof res.body.expiresAt).toBe("number");
    });

    it("returns 200 for a token signed by a retired secret", async () => {
      const oldToken = await signJwt(
        { sub: "user-456", role: "admin", iat: Math.floor(Date.now() / 1000) },
        "retired-secret-key-67890",
        { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: oldToken });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        subject: "user-456",
      });
      expect(typeof res.body.expiresAt).toBe("number");
    });

    it("returns 401 for an expired token", async () => {
      // Create a token that expires immediately/in the past
      const expiredToken = await signJwt(
        { sub: "user-789", role: "customer", iat: Math.floor(Date.now() / 1000) },
        "primary-secret-key-12345",
        { expiresInSec: -10, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: expiredToken });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: "Invalid token", // Doesn't leak 'expired' details
      });
    });

    it("returns 401 for a malformed token", async () => {
      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: "not.a.valid.jwt.format" });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: "Invalid token",
      });
    });

    it("returns 401 for a token signed with an unknown secret", async () => {
      const badSecretToken = await signJwt(
        { sub: "user-999", iat: Math.floor(Date.now() / 1000) },
        "unknown-secret-key-11111",
        { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: badSecretToken });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        success: false,
        error: "Invalid token",
      });
    });

    it("returns 400 when token is missing", async () => {
      const res = await request(app).post("/api/v1/auth/verify").send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: "token is required",
      });
    });

    it("returns 200 with subject from id if sub is missing", async () => {
      const tokenWithId = await signJwt(
        { id: "user-id-only", iat: Math.floor(Date.now() / 1000) },
        "primary-secret-key-12345",
        { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: tokenWithId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        subject: "user-id-only",
      });
    });

    it("returns 200 with null subject if both sub and id are missing", async () => {
      const tokenWithoutSubOrId = await signJwt(
        { role: "guest", iat: Math.floor(Date.now() / 1000) },
        "primary-secret-key-12345",
        { expiresInSec: 3600, issuer: "test-issuer", audience: "test-audience" }
      );

      const res = await request(app)
        .post("/api/v1/auth/verify")
        .send({ token: tokenWithoutSubOrId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        subject: null,
      });
    });
  });
});

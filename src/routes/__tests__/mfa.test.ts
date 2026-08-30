import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import authRouter from "../auth.js";
import { requireFreshMfa } from "../../middleware/requireFreshMfa.js";
import { requireAuth } from "../../middleware/auth.js";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";
import { createFakeMfaRepository } from "../../test-helpers/fakeMfaRepository.js";
import { setMfaRepositoryForTests } from "../../repositories/mfaRepository.js";
import {
  base32Decode,
  generateTotpCode,
  generateTotpSecret,
  totpCounter,
} from "../../utils/totp.js";

const ACCESS_SECRET = "route-access-secret-12345";
const MASTER_KEY = "d".repeat(64);
const CHALLENGE_SECRET = "route-challenge-secret-12345";
const ISSUER = "test-issuer";
const AUDIENCE = "test-audience";

async function accessToken(sub: string): Promise<string> {
  return signJwt(
    { sub, role: "customer", iat: Math.floor(Date.now() / 1000) },
    ACCESS_SECRET,
    { expiresInSec: 3600, issuer: ISSUER, audience: AUDIENCE },
  );
}

function codeForSecret(secretBase32: string, nowMs: number = Date.now()): string {
  return generateTotpCode(base32Decode(secretBase32), totpCounter(nowMs));
}

describe("auth MFA routes", () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = ACCESS_SECRET;
    process.env.JWT_ISSUER = ISSUER;
    process.env.JWT_AUDIENCE = AUDIENCE;
    process.env.MFA_ENCRYPTION_KEY = MASTER_KEY;
    process.env.MFA_CHALLENGE_SECRET = CHALLENGE_SECRET;
    process.env.MFA_ISSUER = ISSUER;
    configService.refresh();

    app = express();
    app.use(express.json());
    app.use("/api/v1/auth", authRouter);
    app.get(
      "/api/v1/risky",
      requireAuth(),
      requireFreshMfa({ issuer: ISSUER, audience: AUDIENCE }),
      (_req, res) => res.status(200).json({ success: true }),
    );
  });

  afterEach(() => {
    setMfaRepositoryForTests(null);
  });

  beforeEach(() => {
    setMfaRepositoryForTests(createFakeMfaRepository().repo);
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.MFA_CHALLENGE_SECRET;
    delete process.env.MFA_ISSUER;
    configService.refresh();
    jest.restoreAllMocks();
  });

  describe("POST /api/v1/auth/mfa/enroll", () => {
    it("requires authentication", async () => {
      const res = await request(app).post("/api/v1/auth/mfa/enroll").send({});
      expect(res.status).toBe(401);
    });

    it("enrols a user and returns the base32 secret + otpauth URI", async () => {
      const token = await accessToken("user-123");
      const res = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.secret).toHaveLength(32);
      expect(res.body.otpauthUrl).toContain(`secret=${res.body.secret}`);
      expect(res.body.digits).toBe(6);
      expect(res.body.period).toBe(30);
      expect(res.body.algorithm).toBe("SHA1");
    });

    it("re-enrols while the previous enrolment is still pending", async () => {
      const token = await accessToken("user-123");
      const first = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      const second = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(second.status).toBe(200);
      expect(second.body.secret).not.toBe(first.body.secret);
    });

    it("rejects enrolling when MFA is already active", async () => {
      const handle = createFakeMfaRepository();
      await handle.seedVerified("user-123", generateTotpSecret(), MASTER_KEY);
      setMfaRepositoryForTests(handle.repo);

      const token = await accessToken("user-123");
      const res = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ success: false, error: "MFA is already enabled for this account" });
    });
  });

  describe("POST /api/v1/auth/mfa/verify", () => {
    it("requires authentication", async () => {
      const res = await request(app).post("/api/v1/auth/mfa/verify").send({ code: "123456" });
      expect(res.status).toBe(401);
    });

    it("rejects a request with no body payload", async () => {
      const token = await accessToken("user-123");
      const res = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it.each(["", "12345", "12345678901", "abcdef", null])("rejects malformed code %j", async (code) => {
      const token = await accessToken("user-123");
      const res = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("returns 404 when the account has no enrolment", async () => {
      const token = await accessToken("nobody");
      const res = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "123456" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: "MFA is not enabled for this account" });
    });

    it("accepts a valid code, activates the enrolment, and returns a challenge token", async () => {
      const token = await accessToken("user-123");
      const enrolled = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      const code = codeForSecret(enrolled.body.secret);

      const res = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.mfaToken).toBeTruthy();
      expect(typeof res.body.expiresInSec).toBe("number");
      expect(typeof res.body.freshUntilSec).toBe("number");
      expect(res.body.alreadyVerified).toBe(false);
    });

    it("rejects a wrong code", async () => {
      const token = await accessToken("user-123");
      const enrolled = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      void enrolled;

      const res = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: "000000" });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: "Invalid or expired MFA code" });
    });

    it("rejects replaying the same code", async () => {
      const token = await accessToken("user-123");
      const enrolled = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      const code = codeForSecret(enrolled.body.secret);

      const first = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code });
      expect(second.status).toBe(409);
      expect(second.body).toEqual({ success: false, error: "This MFA code was already used" });
    });
  });

  describe("POST /api/v1/auth/verify (jwt claims surface)", () => {
    it("returns the id claim as subject when sub is absent", async () => {
      const token = await signJwt(
        { id: "id-only-user", role: "customer", iat: Math.floor(Date.now() / 1000) },
        ACCESS_SECRET,
        { expiresInSec: 3600, issuer: ISSUER, audience: AUDIENCE },
      );
      const res = await request(app).post("/api/v1/auth/verify").send({ token });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, subject: "id-only-user" });
    });

    it("rejects a non-string token", async () => {
      const res = await request(app).post("/api/v1/auth/verify").send({ token: 12345 });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: "token is required" });
    });
  });

  describe("requireFreshMfa integration", () => {
    it("blocks the risky route without an MFA challenge", async () => {
      const token = await accessToken("user-123");
      const res = await request(app).get("/api/v1/risky").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it("allows the risky route after a successful verify", async () => {
      const token = await accessToken("user-123");
      const enrolled = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${token}`)
        .send({});
      const verified = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: codeForSecret(enrolled.body.secret) });
      expect(verified.status).toBe(200);

      const res = await request(app)
        .get("/api/v1/risky")
        .set("Authorization", `Bearer ${token}`)
        .set("x-chronopay-mfa", verified.body.mfaToken);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it("rejects a challenge token for a different user on the risky route", async () => {
      const token = await accessToken("user-123");
      const other = await accessToken("user-999");
      const enrolled = await request(app)
        .post("/api/v1/auth/mfa/enroll")
        .set("Authorization", `Bearer ${other}`)
        .send({});
      const verified = await request(app)
        .post("/api/v1/auth/mfa/verify")
        .set("Authorization", `Bearer ${other}`)
        .send({ code: codeForSecret(enrolled.body.secret) });

      const res = await request(app)
        .get("/api/v1/risky")
        .set("Authorization", `Bearer ${token}`)
        .set("x-chronopay-mfa", verified.body.mfaToken);
      expect(res.status).toBe(403);
    });
  });
});
import request from "supertest";
import app from "../index.js";
import { SignJWT } from "jose";
import { authenticateToken } from "../middleware/auth.js";
import type { Request, Response, NextFunction } from "express";

const TEST_SECRET = "test-secret-key-at-least-32-chars!!";

/**
 * Generates a signed HS256 JWT for testing.
 *
 * @param claims  - JWT payload claims (default: { sub: "user-1" })
 * @param secret  - Signing secret (default: TEST_SECRET)
 * @param exp     - Expiration string accepted by jose (default: "1h")
 */
async function makeToken(
  claims: Record<string, unknown> = { sub: "user-1" },
  secret: string = TEST_SECRET,
  exp: string = "1h",
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

/**
 * Generates a JWT that is already expired at the time of creation.
 * iat = 2 hours ago, exp = 1 hour ago.
 */
async function makeExpiredToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "user-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now - 7200) // issued 2 hours ago
    .setExpirationTime(now - 3600) // expired 1 hour ago
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe("authenticateToken middleware", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  // --- Public routes must remain accessible without a token ---

  it("GET /health returns 200 without an Authorization header", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  // --- Missing Authorization header ---

  it("GET /api/v1/slots returns 401 when Authorization header is absent", async () => {
    const res = await request(app).get("/api/v1/slots");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Authorization header is required/i);
  });

  it("POST /api/v1/slots returns 401 when Authorization header is absent", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .send({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // --- Wrong authorization scheme ---

  it("returns 401 when Authorization uses a non-Bearer scheme", async () => {
    const token = await makeToken();
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", `Token ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Bearer scheme/i);
  });

  // --- Empty token after "Bearer " prefix ---
  // Node's HTTP parser trims trailing whitespace, so sending "Bearer " via HTTP
  // results in "Bearer" reaching Express, which triggers the scheme check instead.
  // We cover the empty-token branch with a direct middleware unit test that
  // bypasses the HTTP layer to exercise this defensive code path.

  it("returns 401 when Authorization header is 'Bearer ' with no token (HTTP path)", async () => {
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", "Bearer ");
    // HTTP parser trims trailing space → hits scheme check, still 401
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 with 'Bearer token is missing' when token is empty string (unit test)", async () => {
    // Directly invoke the middleware with a mock req that bypasses HTTP parsing,
    // allowing us to exercise the defensive !token branch (lines 82–88 in auth.ts).
    const mockReq = {
      headers: { authorization: "Bearer " },
    } as unknown as Request;

    let capturedStatus = 0;
    let capturedBody: Record<string, unknown> = {};

    const mockRes = {
      status(code: number) {
        capturedStatus = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        capturedBody = body;
        return this;
      },
    } as unknown as Response;

    let nextCalled = false;
    const mockNext = (() => { nextCalled = true; }) as unknown as NextFunction;

    await authenticateToken(mockReq, mockRes, mockNext);

    expect(capturedStatus).toBe(401);
    expect(capturedBody.success).toBe(false);
    expect(capturedBody.error).toMatch(/Bearer token is missing/i);
    expect(nextCalled).toBe(false);
  });

  // --- Malformed / invalid tokens ---

  it("returns 401 for a structurally invalid token string", async () => {
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", "Bearer this.is.not.a.valid.jwt");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid or expired token/i);
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const token = await makeToken({ sub: "user-1" }, "wrong-secret-entirely!!");
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid or expired token/i);
  });

  it("returns 401 for an expired token", async () => {
    const token = await makeExpiredToken();
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Invalid or expired token/i);
  });

  // --- Valid token — protected routes succeed ---

  it("GET /api/v1/slots returns 200 with a valid token", async () => {
    const token = await makeToken();
    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slots)).toBe(true);
  });

  it("POST /api/v1/slots returns 201 with a valid token and complete body", async () => {
    const token = await makeToken();
    const res = await request(app)
      .post("/api/v1/slots")
      .set("Authorization", `Bearer ${token}`)
      .send({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.slot).toMatchObject({ professional: "alice" });
  });

  // --- 500 branch: JWT_SECRET not configured ---

  it("returns 500 when JWT_SECRET is not set", async () => {
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    const res = await request(app)
      .get("/api/v1/slots")
      .set("Authorization", "Bearer any.token.value");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Authentication middleware error/i);

    // Restore for subsequent tests
    process.env.JWT_SECRET = savedSecret;
  });
});

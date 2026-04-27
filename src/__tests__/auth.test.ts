import request from "supertest";
import app from "../index.js";
import { SignJWT } from "jose";
import { authenticateToken } from "../middleware/auth.js";
import type { Request, Response, NextFunction } from "express";

const TEST_SECRET = "test-secret-key-at-least-32-chars!!";

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

async function makeExpiredToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "user-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 3600)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe("authenticateToken middleware", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  // --- Public routes remain accessible without a token ---

  it("GET /health returns 200 without an Authorization header", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  // --- Unit tests for authenticateToken middleware ---

  it("returns 401 with 'Authorization header is required' when header is absent (unit test)", async () => {
    const mockReq = { headers: {} } as unknown as Request;
    let capturedStatus = 0;
    let capturedBody: Record<string, unknown> = {};
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json(body: Record<string, unknown>) { capturedBody = body; return this; },
    } as unknown as Response;
    let nextCalled = false;
    const mockNext = (() => { nextCalled = true; }) as unknown as NextFunction;

    await authenticateToken(mockReq, mockRes, mockNext);

    expect(capturedStatus).toBe(401);
    expect(capturedBody.success).toBe(false);
    expect(capturedBody.error).toMatch(/Authorization header is required/i);
    expect(nextCalled).toBe(false);
  });

  it("returns 401 with 'Bearer scheme' when non-Bearer scheme used (unit test)", async () => {
    const token = await makeToken();
    const mockReq = { headers: { authorization: `Token ${token}` } } as unknown as Request;
    let capturedStatus = 0;
    let capturedBody: Record<string, unknown> = {};
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json(body: Record<string, unknown>) { capturedBody = body; return this; },
    } as unknown as Response;
    const mockNext = (() => {}) as unknown as NextFunction;

    await authenticateToken(mockReq, mockRes, mockNext);

    expect(capturedStatus).toBe(401);
    expect(capturedBody.success).toBe(false);
    expect(capturedBody.error).toMatch(/Bearer scheme/i);
  });

  it("returns 401 with 'Bearer token is missing' when token is empty string (unit test)", async () => {
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

  it("returns 401 for a structurally invalid token string (unit test)", async () => {
    const mockReq = { headers: { authorization: "Bearer this.is.not.a.valid.jwt" } } as unknown as Request;
    let capturedStatus = 0;
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json() { return this; },
    } as unknown as Response;
    await authenticateToken(mockReq, mockRes, (() => {}) as unknown as NextFunction);
    expect(capturedStatus).toBe(401);
  });

  it("returns 401 for a token signed with the wrong secret (unit test)", async () => {
    const token = await makeToken({ sub: "user-1" }, "wrong-secret-entirely!!");
    const mockReq = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    let capturedStatus = 0;
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json() { return this; },
    } as unknown as Response;
    await authenticateToken(mockReq, mockRes, (() => {}) as unknown as NextFunction);
    expect(capturedStatus).toBe(401);
  });

  it("returns 401 for an expired token (unit test)", async () => {
    const token = await makeExpiredToken();
    const mockReq = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    let capturedStatus = 0;
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json() { return this; },
    } as unknown as Response;
    await authenticateToken(mockReq, mockRes, (() => {}) as unknown as NextFunction);
    expect(capturedStatus).toBe(401);
  });

  it("calls next() for a valid token (unit test)", async () => {
    const token = await makeToken();
    const mockReq = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    const mockRes = {
      status() { return this; },
      json() { return this; },
    } as unknown as Response;
    let nextCalled = false;
    await authenticateToken(mockReq, mockRes, (() => { nextCalled = true; }) as unknown as NextFunction);
    expect(nextCalled).toBe(true);
  });

  it("returns 500 when JWT_SECRET is not set (unit test)", async () => {
    const savedSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    const mockReq = { headers: { authorization: "Bearer any.token.value" } } as unknown as Request;
    let capturedStatus = 0;
    let capturedBody: Record<string, unknown> = {};
    const mockRes = {
      status(code: number) { capturedStatus = code; return this; },
      json(body: Record<string, unknown>) { capturedBody = body; return this; },
    } as unknown as Response;

    await authenticateToken(mockReq, mockRes, (() => {}) as unknown as NextFunction);

    expect(capturedStatus).toBe(500);
    expect(capturedBody.success).toBe(false);
    expect(capturedBody.error).toMatch(/Authentication middleware error/i);

    process.env.JWT_SECRET = savedSecret;
  });

  // --- HTTP integration: slots are accessible without JWT (RBAC-based auth) ---

  it("GET /api/v1/slots returns 200 without Authorization header", async () => {
    const res = await request(app).get("/api/v1/slots");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slots)).toBe(true);
  });

  it("POST /api/v1/slots returns 201 with valid role header and body", async () => {
    const res = await request(app)
      .post("/api/v1/slots")
      .set("x-user-role", "professional")
      .send({ professional: "alice", startTime: 1000, endTime: 2000 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.slot).toMatchObject({ professional: "alice" });
  });
});

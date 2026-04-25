import jwt from "jsonwebtoken";
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
import { Request, Response, NextFunction } from "express";

let verifyJwt: (token: string) => any;
let authenticate: (req: Request, res: Response, next: NextFunction) => void;

const createMockRequest = (headers: Record<string, string> = {}): Request =>
  ({ headers }) as Request;
const createMockResponse = (): Response => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res as Response) as Response["status"];
  res.json = jest.fn().mockReturnValue(res as Response) as Response["json"];
  return res as Response;
};
const createMockNext = (): NextFunction => jest.fn();

describe("JWT Verification Utility", () => {
  const testSecret = "test-secret";
  const testIssuer = "test-issuer";
  const testAudience = "test-audience";
  const testLeeway = 30;
  const testAlgorithms = "HS256";

  beforeAll(async () => {
    process.env.JWT_SECRET = testSecret;
    process.env.JWT_ISSUER = testIssuer;
    process.env.JWT_AUDIENCE = testAudience;
    process.env.JWT_LEEWAY = testLeeway.toString();
    process.env.JWT_ALGORITHMS = testAlgorithms;

    jest.resetModules();

    const jwtModule = await import("../utils/jwt.js");
    verifyJwt = jwtModule.verifyJwt;
  });

  afterAll(() => {
    [
      "JWT_SECRET",
      "JWT_ISSUER",
      "JWT_AUDIENCE",
      "JWT_LEEWAY",
      "JWT_ALGORITHMS",
    ].forEach((k) => delete process.env[k]);
    jest.resetModules();
  });

  it("validates valid token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
    });
    const decoded = verifyJwt(token);
    expect(decoded.exp).toBe(now + 3600);
    expect(decoded.iat).toBe(now);
  });

  it("rejects expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now - 3600, iat: now }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects invalid issuer", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, testSecret, {
      issuer: "wrong",
      audience: testAudience,
      algorithm: "HS256",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects invalid audience", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, testSecret, {
      issuer: testIssuer,
      audience: "wrong",
      algorithm: "HS256",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects missing exp", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ iat: now }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects missing iat", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600 }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
      noTimestamp: true,
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects future iat beyond leeway", () => {
    const now = Math.floor(Date.now() / 1000);
    const futureIat = now + testLeeway + 10;
    const token = jwt.sign(
      { exp: futureIat + 3600, iat: futureIat },
      testSecret,
      { issuer: testIssuer, audience: testAudience, algorithm: "HS256" },
    );
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("accepts iat within leeway", () => {
    const now = Math.floor(Date.now() / 1000);
    const futureIat = now + testLeeway - 5;
    const token = jwt.sign(
      { exp: futureIat + 3600, iat: futureIat },
      testSecret,
      { issuer: testIssuer, audience: testAudience, algorithm: "HS256" },
    );
    expect(() => verifyJwt(token)).not.toThrow();
  });

  it("rejects malformed token", () =>
    expect(() => verifyJwt("malformed")).toThrow("INVALID_TOKEN"));

  it("rejects invalid signature", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, "wrong-secret", {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects invalid algorithm", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS384",
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });

  it("rejects none algorithm attack", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, "", {
      algorithm: "none" as any,
    });
    expect(() => verifyJwt(token)).toThrow("INVALID_TOKEN");
  });
});

describe("Auth Middleware", () => {
  const testSecret = "test-secret";
  const testIssuer = "test-issuer";
  const testAudience = "test-audience";
  const testLeeway = 30;
  const testAlgorithms = "HS256";

  beforeAll(async () => {
    process.env.JWT_SECRET = testSecret;
    process.env.JWT_ISSUER = testIssuer;
    process.env.JWT_AUDIENCE = testAudience;
    process.env.JWT_LEEWAY = testLeeway.toString();
    process.env.JWT_ALGORITHMS = testAlgorithms;

    jest.resetModules();

    const authModule = await import("../middleware/auth.middleware.js");
    authenticate = authModule.authenticate;
  });

  afterAll(() => {
    [
      "JWT_SECRET",
      "JWT_ISSUER",
      "JWT_AUDIENCE",
      "JWT_LEEWAY",
      "JWT_ALGORITHMS",
    ].forEach((k) => delete process.env[k]);
    jest.resetModules();
  });

  it("returns 401 with no auth header", () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = createMockNext();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with invalid auth type", () => {
    const req = createMockRequest({ authorization: "Basic token" });
    const res = createMockResponse();
    const next = createMockNext();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 with malformed bearer token", () => {
    const req = createMockRequest({ authorization: "Bearer" });
    const res = createMockResponse();
    const next = createMockNext();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches user on valid token", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600, iat: now }, testSecret, {
      issuer: testIssuer,
      audience: testAudience,
      algorithm: "HS256",
    });
    const req = createMockRequest({ authorization: `Bearer ${token}` });
    const res = createMockResponse();
    const next = createMockNext();
    authenticate(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeDefined();
    expect(req.user?.exp).toBe(now + 3600);
  });

  it("returns 401 on invalid token", () => {
    const req = createMockRequest({ authorization: "Bearer invalid-token" });
    const res = createMockResponse();
    const next = createMockNext();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

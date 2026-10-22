import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { configService } from "../../config/config.service.js";
import { signJwt } from "../../utils/jwt.js";
import { requireAuthenticatedActor } from "../auth.js";
import { requirePermission, requireRole } from "../rbac.js";

const TEST_SECRET = "test-jwt-secret-with-at-least-32-characters-length";

const guardedMiddleware = [
  ["requireAuthenticatedActor", () => requireAuthenticatedActor(["admin"])],
  ["requireRole", () => requireRole("admin")],
  ["requirePermission", () => requirePermission("users:delete")],
] as const;

async function makeToken(role: string, subject = "user-1", expiresInSec = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { sub: subject, role, iat: now, exp: now + expiresInSec },
    TEST_SECRET,
  );
}

async function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => unknown,
  headers: Record<string, string> = {},
) {
  const req = {
    headers,
    ip: "127.0.0.1",
    method: "GET",
    originalUrl: "/protected",
  } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;

  await middleware(req, res, next);
  return { req, res, next };
}

describe("JWT-backed authorization middleware", () => {
  beforeEach(() => {
    jest.spyOn(configService, "getAllSecretVersions").mockReturnValue([TEST_SECRET]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(guardedMiddleware)("%s rejects spoofed identity headers without a bearer token", async (_name, createMiddleware) => {
    const { res, next } = await runMiddleware(createMiddleware(), {
      "x-chronopay-user-id": "attacker",
      "x-chronopay-role": "admin",
      "x-user-role": "admin",
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(guardedMiddleware)("%s ignores forged admin headers when the JWT role is customer", async (_name, createMiddleware) => {
    const token = await makeToken("customer");
    const { res, next, req } = await runMiddleware(createMiddleware(), {
      authorization: `Bearer ${token}`,
      "x-chronopay-user-id": "attacker",
      "x-chronopay-role": "admin",
      "x-user-role": "admin",
    });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.auth).toMatchObject({ userId: "user-1", role: "customer" });
  });

  it.each(guardedMiddleware)("%s accepts a valid admin JWT", async (_name, createMiddleware) => {
    const token = await makeToken("admin");
    const { next, req } = await runMiddleware(createMiddleware(), {
      authorization: `Bearer ${token}`,
    });

    expect(next).toHaveBeenCalled();
    expect(req.auth).toMatchObject({ userId: "user-1", role: "admin" });
  });

  it.each(guardedMiddleware)("%s rejects an expired JWT", async (_name, createMiddleware) => {
    const token = await makeToken("admin", "user-1", -1);
    const { res, next } = await runMiddleware(createMiddleware(), {
      authorization: `Bearer ${token}`,
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

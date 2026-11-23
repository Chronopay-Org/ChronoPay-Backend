import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { Request } from "express";
import type { VerifiedJwtPayload } from "../../utils/jwt.js";

const verifyJwtMock = jest.fn<
  (token: string, options?: { issuer?: string; audience?: string }) => Promise<VerifiedJwtPayload>
>();

jest.unstable_mockModule("../../utils/jwt.js", () => ({
  verifyJwt: verifyJwtMock,
}));
jest.unstable_mockModule("../../config/config.service.js", () => ({
  configService: {
    jwtIssuer: "configured-issuer",
  },
}));

const { getUserId, MissingBearerTokenError, readBearerToken, verifyRequestJwt } = await import("../jwtIdentity.js");

function makeRequest(authorization?: string): Request {
  return { headers: { authorization } } as Request;
}

describe("jwtIdentity helpers", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("readBearerToken", () => {
    it("extracts and trims a Bearer token", () => {
      expect(readBearerToken(makeRequest("Bearer abc "))).toBe("abc");
    });

    it("returns null for an unsupported scheme or empty token", () => {
      expect(readBearerToken(makeRequest("bearer abc"))).toBeNull();
      expect(readBearerToken(makeRequest("Bearer "))).toBeNull();
      expect(readBearerToken(makeRequest())).toBeNull();
    });
  });

  describe("getUserId", () => {
    it("trims sub and prefers it over id", () => {
      expect(getUserId({ sub: " u1 ", id: "other", exp: 1 })).toBe("u1");
    });

    it("returns an empty string when the id claim is not a string", () => {
      expect(getUserId({ id: 5, exp: 1 })).toBe("");
    });

    it("falls back to a string id when sub is absent", () => {
      expect(getUserId({ id: "u2", exp: 1 })).toBe("u2");
    });
  });

  describe("verifyRequestJwt", () => {
    it("throws MissingBearerTokenError when the Authorization header is missing", async () => {
      await expect(verifyRequestJwt(makeRequest())).rejects.toBeInstanceOf(MissingBearerTokenError);
      expect(verifyJwtMock).not.toHaveBeenCalled();
    });

    it("passes expectedIssuer in preference to the configured issuer", async () => {
      const payload = { sub: "u1", exp: 1 };
      verifyJwtMock.mockResolvedValue(payload);

      await expect(verifyRequestJwt(makeRequest("Bearer abc"), "expected-issuer")).resolves.toBe(payload);
      expect(verifyJwtMock).toHaveBeenCalledWith("abc", { issuer: "expected-issuer" });
    });

    it("uses the configured issuer when expectedIssuer is absent", async () => {
      verifyJwtMock.mockResolvedValue({ sub: "u1", exp: 1 });

      await verifyRequestJwt(makeRequest("Bearer abc"));

      expect(verifyJwtMock).toHaveBeenCalledWith("abc", { issuer: "configured-issuer" });
    });
  });
});

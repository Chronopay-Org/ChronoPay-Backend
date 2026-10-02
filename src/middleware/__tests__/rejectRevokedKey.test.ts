import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";
import { SIGNING_KEY_HEADER, rejectRevokedKey } from "../rejectRevokedKey.js";
import type { RevocationService } from "../../services/revocationService.js";

/**
 * Focused behavior coverage for src/middleware/rejectRevokedKey.ts (#1121).
 *
 * The middleware is exercised directly through mocked req/res/next doubles so
 * every branch is deterministic and offline — no app bootstrap, no Redis.
 */

function makeReq(headers: Record<string, unknown> = {}): Request {
  return { headers } as unknown as Request;
}

type MockResponse = Response & {
  status: jest.Mock<(code: number) => Response>;
  json: jest.Mock<(payload: unknown) => Response>;
};

function makeRes(): MockResponse {
  const res = {
    status: jest.fn<(code: number) => Response>(),
    json: jest.fn<(payload: unknown) => Response>(),
  } as unknown as MockResponse;
  res.status.mockReturnThis();
  return res;
}

function makeRevocationService(revoked: string[] = []): RevocationService {
  const set = new Set(revoked);
  return {
    isRevoked: (keyId: string) => set.has(keyId),
  } as unknown as RevocationService;
}

describe("SIGNING_KEY_HEADER", () => {
  it("is the lowercase x-signing-key-id header per Express convention", () => {
    expect(SIGNING_KEY_HEADER).toBe("x-signing-key-id");
  });
});

describe("rejectRevokedKey", () => {
  let next: NextFunction;
  let res: ReturnType<typeof makeRes>;

  beforeEach(() => {
    next = jest.fn();
    res = makeRes();
  });

  describe("header absent — pass-through", () => {
    it("calls next() when the header is missing", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["key-1"]));

      middleware(makeReq(), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("does not consult the revocation service when the header is missing", () => {
      const service = makeRevocationService(["key-1"]);
      const spy = jest.spyOn(service, "isRevoked");
      const middleware = rejectRevokedKey(service);

      middleware(makeReq(), res, next);

      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ["empty object", {}],
      ["empty-string header", { "x-signing-key-id": "" }],
      ["null header value", { "x-signing-key-id": null }],
    ])("treats %s as absent and calls next()", (_name, headers) => {
      const middleware = rejectRevokedKey(makeRevocationService(["key-1"]));

      middleware(makeReq(headers), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("key revoked — 401 structured error", () => {
    it("responds 401 with the KEY_REVOKED payload and never calls next()", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["key-1"]));

      middleware(makeReq({ "x-signing-key-id": "key-1" }), res, next);

      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        code: "KEY_REVOKED",
        error: "The signing key presented has been revoked.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("only rejects keys present in the revocation set", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["revoked-a", "revoked-b"]));

      middleware(makeReq({ "x-signing-key-id": "revoked-b" }), res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("responds 401 for unknown-but-revoked-looking IDs without leaking others", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["key-live"]));

      middleware(makeReq({ "x-signing-key-id": "key-dead" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it("checks revocation with the exact header value (case-sensitive)", () => {
      const service = makeRevocationService(["key-1"]);
      const spy = jest.spyOn(service, "isRevoked");
      const middleware = rejectRevokedKey(service);

      middleware(makeReq({ "x-signing-key-id": "KEY-1" }), res, next);

      expect(spy).toHaveBeenCalledWith("KEY-1");
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("key present and valid — pass-through", () => {
    it("calls next() without touching the response", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["revoked-key"]));

      middleware(makeReq({ "x-signing-key-id": "valid-key" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it("queries the revocation service exactly once with the header value", () => {
      const service = makeRevocationService([]);
      const spy = jest.spyOn(service, "isRevoked");
      const middleware = rejectRevokedKey(service);

      middleware(makeReq({ "x-signing-key-id": "key-9" }), res, next);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("key-9");
    });

    it.each([
      ["single revoked key revoked", ["key-1"], "key-1", 401],
      ["single revoked key valid", ["key-1"], "key-9", 0],
      ["empty revocation set", [], "key-1", 0],
    ])("%s → status %i", (_name, revoked, presented, expectedStatus) => {
      const middleware = rejectRevokedKey(makeRevocationService(revoked));

      middleware(makeReq({ "x-signing-key-id": presented }), res, next);

      if (expectedStatus === 401) {
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
      } else {
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      }
    });
  });

  describe("boundary: array-valued headers", () => {
    it("uses the first element of an array-valued header", () => {
      const service = makeRevocationService(["first", "second"]);
      const spy = jest.spyOn(service, "isRevoked");
      const middleware = rejectRevokedKey(service);

      middleware(makeReq({ "x-signing-key-id": ["first", "second"] }), res, next);

      expect(spy).toHaveBeenCalledWith("first");
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it("passes through when the first array element is not revoked", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["second"]));

      middleware(makeReq({ "x-signing-key-id": ["first", "second"] }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe("state transitions", () => {
    it("reflects a key revoked after the middleware was constructed", () => {
      const service = makeRevocationService([]);
      const middleware = rejectRevokedKey(service);

      middleware(makeReq({ "x-signing-key-id": "key-1" }), res, next);
      expect(next).toHaveBeenCalledTimes(1);

      (service as unknown as { isRevoked: (keyId: string) => boolean }).isRevoked = () => true;
      middleware(makeReq({ "x-signing-key-id": "key-1" }), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects repeated presentations of the same revoked key deterministically", () => {
      const middleware = rejectRevokedKey(makeRevocationService(["key-1"]));
      const req = makeReq({ "x-signing-key-id": "key-1" });

      for (let i = 0; i < 3; i += 1) {
        middleware(req, res, next);
      }

      expect(res.status).toHaveBeenCalledTimes(3);
      expect(res.status).toHaveBeenLastCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

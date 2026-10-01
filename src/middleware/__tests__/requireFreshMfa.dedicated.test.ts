/**
 * Dedicated regression suite for requireFreshMfa and RequireFreshMfaOptions.
 *
 * `src/middleware/__tests__/requireFreshMfa.test.ts` drives the middleware
 * through `supertest` with real access tokens, which means several of the
 * middleware's own guards are unreachable from there:
 *
 * - the **array-valued header** branch (`Array.isArray(raw) ? raw[0] : raw`),
 *   which is what Express actually hands over when a header is repeated,
 * - the **non-string header** fallback (`typeof header === "string" ? … : ""`),
 * - **whitespace trimming** of the token,
 * - **check ordering** — a missing header is reported before the missing-user
 *   check, so no unauthenticated probe can distinguish the two,
 * - the **option pass-through**: `RequireFreshMfaOptions` is forwarded to the
 *   verifier field-by-field, including `nowMs`, which the existing suite never
 *   exercises,
 * - the **complete error → HTTP mapping**, including the catch-all 500, asserted
 *   to never call `next()`.
 *
 * The suite carries two layers:
 *   • an end-to-end layer that signs real challenge tokens with `signJwt` and
 *     runs them through the real middleware and the real `mfaService`, covering
 *     the freshness boundaries deterministically via the injected `nowMs`;
 *   • a unit layer that pins one typed failure at a time onto the verifier, so
 *     every mapping is reachable without depending on a token shape.
 *
 * Requests and responses are plain doubles rather than Express instances, so
 * header edge cases (arrays, non-strings) can be constructed exactly.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { requireFreshMfa } from "../requireFreshMfa.js";
import { mfaService } from "../../services/mfaService.js";
import { signJwt } from "../../utils/jwt.js";
import {
  MfaChallengeExpiredError,
  MfaChallengeInvalidError,
  MfaConfigurationError,
} from "../../errors/mfaErrors.js";

type Middleware = ReturnType<typeof requireFreshMfa>;
type Req = Parameters<Middleware>[0];
type Res = Parameters<Middleware>[1];
type Next = Parameters<Middleware>[2];

const CHALLENGE_SECRET = "challenge-secret-for-this-suite-0123456789";
const ISSUER = "suite-issuer";
const AUDIENCE = "suite-audience";

const realNowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface ResDouble {
  statusCode: number | null;
  body: unknown;
  status(code: number): ResDouble;
  json(payload: unknown): ResDouble;
}

function makeRes(): ResDouble {
  const res: ResDouble = {
    statusCode: null,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function makeReq(headers: Record<string, unknown>, auth?: { userId?: string }): Req {
  return { headers, auth } as unknown as Req;
}

interface Invocation {
  status: number | null;
  body: unknown;
  nextCalls: number;
}

async function invoke(
  options: Parameters<typeof requireFreshMfa>[0],
  req: Req,
): Promise<Invocation> {
  const res = makeRes();
  let nextCalls = 0;
  const next: Next = (() => {
    nextCalls += 1;
  }) as unknown as Next;

  await requireFreshMfa(options)(req, res as unknown as Res, next);
  return { status: res.statusCode, body: res.body, nextCalls };
}

/** Signs a challenge token whose mfa_at mirrors iat, as the service issues them. */
function challenge(
  subject: string | undefined,
  atSec: number,
  extra: Record<string, unknown> = {},
  ttlSec = 3600,
): Promise<string> {
  const payload: Record<string, unknown> = { iat: atSec, mfa_at: atSec, ...extra };
  if (subject !== undefined) payload.sub = subject;
  return signJwt(payload, CHALLENGE_SECRET, {
    expiresInSec: ttlSec,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

const baseOptions = { challengeSecret: CHALLENGE_SECRET, issuer: ISSUER, audience: AUDIENCE };

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("requireFreshMfa — dedicated coverage", () => {
  // -------------------------------------------------------------------------
  // Header parsing
  // -------------------------------------------------------------------------
  describe("header parsing", () => {
    it("accepts an array-valued header by using its first entry", async () => {
      const token = await challenge("user-1", realNowSec());
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": [token] }, { userId: "user-1" }),
      );

      expect(result.status).toBeNull(); // no error response -> handler ran
      expect(result.nextCalls).toBe(1);
    });

    it("uses the FIRST array entry, not any later valid one", async () => {
      const token = await challenge("user-1", realNowSec());
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": ["not-a-token", token] }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
      expect(result.nextCalls).toBe(0);
    });

    it("treats a non-string header value as a missing challenge", async () => {
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": 12345 }, { userId: "user-1" }),
      );

      expect(result.status).toBe(401);
      expect(result.body).toEqual({ success: false, error: "Missing MFA challenge" });
    });

    it("treats an undefined header value as a missing challenge", async () => {
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": undefined }, { userId: "user-1" }),
      );

      expect(result.status).toBe(401);
      expect(result.body).toEqual({ success: false, error: "Missing MFA challenge" });
    });

    it("trims surrounding whitespace from the challenge token", async () => {
      const token = await challenge("user-1", realNowSec());
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": `  \t ${token}  ` }, { userId: "user-1" }),
      );

      expect(result.status).toBeNull();
      expect(result.nextCalls).toBe(1);
    });

    it("treats a whitespace-only header as missing regardless of the user", async () => {
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": "   " }, { userId: "u" }),
      );
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ success: false, error: "Missing MFA challenge" });
    });

    it("reports the missing challenge before the missing-user check", async () => {
      // Ordering matters: an unauthenticated caller with no header must not be
      // able to tell whether authentication would have succeeded.
      const withNoUser = await invoke(baseOptions, makeReq({}));
      const withUser = await invoke(baseOptions, makeReq({}, { userId: "user-1" }));

      expect(withNoUser.status).toBe(401);
      expect(withUser.status).toBe(401);
      expect(withNoUser.body).toEqual(withUser.body);
    });
  });

  // -------------------------------------------------------------------------
  // Authentication guard
  // -------------------------------------------------------------------------
  describe("authentication guard", () => {
    it("rejects a request with no req.auth at all", async () => {
      const token = await challenge("user-1", realNowSec());
      const result = await invoke(baseOptions, makeReq({ "x-chronopay-mfa": token }));

      expect(result.status).toBe(401);
      expect(result.body).toEqual({ success: false, error: "Authentication required" });
      expect(result.nextCalls).toBe(0);
    });

    it("rejects an empty userId on req.auth", async () => {
      const token = await challenge("user-1", realNowSec());
      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": token }, { userId: "" }),
      );

      expect(result.status).toBe(401);
      expect(result.body).toEqual({ success: false, error: "Authentication required" });
    });
  });

  // -------------------------------------------------------------------------
  // Real tokens end-to-end: success and freshness boundaries
  // -------------------------------------------------------------------------
  describe("real challenge tokens", () => {
    it("allows a fresh, user-bound challenge", async () => {
      const at = realNowSec();
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 900_000, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBeNull();
      expect(result.nextCalls).toBe(1);
    });

    it("allows a challenge aged exactly the freshness window", async () => {
      const at = realNowSec() - 600;
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 900_000, nowMs: (at + 900) * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBeNull();
    });

    it("truncates a sub-second excess, so one millisecond over the window is still fresh", async () => {
      // `nowSec` is `Math.floor(nowMs / 1000)`, so the effective granularity of
      // the freshness check is one second, not one millisecond.
      const at = realNowSec() - 600;
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 900_000, nowMs: (at + 900) * 1000 + 1 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBeNull();
    });

    it("rejects a challenge one whole second past the freshness window", async () => {
      const at = realNowSec() - 600;
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 900_000, nowMs: (at + 901) * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBe(401);
      expect(result.body).toEqual({
        success: false,
        error: "MFA challenge has expired; please verify again",
      });
    });

    it("rejects a challenge minted in the future (negative age)", async () => {
      const at = realNowSec() + 60;
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 900_000, nowMs: realNowSec() * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBe(401);
    });

    it("honours a per-route window narrower than the default", async () => {
      const at = realNowSec() - 300;
      const result = await invoke(
        { ...baseOptions, maxAgeMs: 60_000, nowMs: at * 1000 + 300_000 },
        makeReq({ "x-chronopay-mfa": await challenge("user-1", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBe(401);
    });

    it("rejects a challenge bound to a different subject", async () => {
      const at = realNowSec();
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge("someone-else", at) }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
      expect(result.body).toEqual({ success: false, error: "Invalid MFA challenge" });
    });

    it("rejects a token with no subject claim", async () => {
      const at = realNowSec();
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": await challenge(undefined, at) }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
    });

    it("rejects a token whose mfa_at disagrees with its iat", async () => {
      const at = realNowSec();
      const token = await signJwt({ sub: "user-1", iat: at, mfa_at: at - 30 }, CHALLENGE_SECRET, {
        expiresInSec: 3600,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": token }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
    });

    it("rejects a token signed with a different secret", async () => {
      const at = realNowSec();
      const token = await signJwt(
        { sub: "user-1", iat: at, mfa_at: at },
        "a-different-secret-entirely",
        {
          expiresInSec: 3600,
          issuer: ISSUER,
          audience: AUDIENCE,
        },
      );
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": token }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
    });

    it("rejects a challenge whose JWT lifetime has already elapsed", async () => {
      const at = realNowSec();
      const token = await challenge("user-1", at, {}, -10);
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": token }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
    });

    it("rejects a token issued for a different audience", async () => {
      const at = realNowSec();
      const token = await signJwt({ sub: "user-1", iat: at, mfa_at: at }, CHALLENGE_SECRET, {
        expiresInSec: 3600,
        issuer: ISSUER,
        audience: "someone-elses-api",
      });
      const result = await invoke(
        { ...baseOptions, nowMs: at * 1000 },
        makeReq({ "x-chronopay-mfa": token }, { userId: "user-1" }),
      );

      expect(result.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Option pass-through (RequireFreshMfaOptions)
  // -------------------------------------------------------------------------
  describe("RequireFreshMfaOptions pass-through", () => {
    it("forwards every option to the verifier verbatim", async () => {
      const spy = jest.spyOn(mfaService, "verifyChallenge").mockResolvedValue({
        userId: "user-1",
        mfaAtSec: 1,
        freshUntilSec: 2,
      });

      await invoke(
        {
          maxAgeMs: 12_345,
          challengeSecret: "explicit-secret",
          issuer: "explicit-issuer",
          audience: "explicit-audience",
          nowMs: 999_000,
        },
        makeReq({ "x-chronopay-mfa": "any-token" }, { userId: "user-1" }),
      );

      expect(spy).toHaveBeenCalledTimes(1);
      const [token, options] = spy.mock.calls[0] as [string, Record<string, unknown>];
      expect(token).toBe("any-token");
      expect(options).toEqual({
        expectedUserId: "user-1",
        challengeSecret: "explicit-secret",
        issuer: "explicit-issuer",
        audience: "explicit-audience",
        freshnessMs: 12_345,
        nowMs: 999_000,
      });
    });

    it("forwards an all-defaults option set without inventing values", async () => {
      const spy = jest.spyOn(mfaService, "verifyChallenge").mockResolvedValue({
        userId: "user-1",
        mfaAtSec: 1,
        freshUntilSec: 2,
      });

      await invoke({}, makeReq({ "x-chronopay-mfa": "tok" }, { userId: "user-1" }));

      const [, options] = spy.mock.calls[0] as [string, Record<string, unknown>];
      expect(options).toEqual({
        expectedUserId: "user-1",
        challengeSecret: undefined,
        issuer: undefined,
        audience: undefined,
        freshnessMs: undefined,
        nowMs: undefined,
      });
    });

    it("passes the trimmed token to the verifier, not the raw header", async () => {
      const spy = jest.spyOn(mfaService, "verifyChallenge").mockResolvedValue({
        userId: "user-1",
        mfaAtSec: 1,
        freshUntilSec: 2,
      });

      await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": "   tidy-token   " }, { userId: "user-1" }),
      );

      expect(spy.mock.calls[0][0]).toBe("tidy-token");
    });
  });

  // -------------------------------------------------------------------------
  // Error to HTTP mapping
  // -------------------------------------------------------------------------
  describe("error to HTTP mapping", () => {
    const cases: { label: string; error: Error; status: number; body: unknown }[] = [
      {
        label: "MfaConfigurationError",
        error: new MfaConfigurationError("MFA_CHALLENGE_SECRET is not provisioned"),
        status: 500,
        body: { success: false, error: "MFA is not configured" },
      },
      {
        label: "MfaChallengeExpiredError",
        error: new MfaChallengeExpiredError(),
        status: 401,
        body: { success: false, error: "MFA challenge has expired; please verify again" },
      },
      {
        label: "MfaChallengeInvalidError",
        error: new MfaChallengeInvalidError(),
        status: 403,
        body: { success: false, error: "Invalid MFA challenge" },
      },
      {
        label: "unexpected error",
        error: new TypeError("something exploded"),
        status: 500,
        body: { success: false, error: "Failed to verify MFA challenge" },
      },
    ];

    for (const { label, error, status, body } of cases) {
      it(`maps ${label} to ${status} and does not call next()`, async () => {
        jest.spyOn(mfaService, "verifyChallenge").mockRejectedValue(error);

        const result = await invoke(
          baseOptions,
          makeReq({ "x-chronopay-mfa": "tok" }, { userId: "user-1" }),
        );

        expect(result.status).toBe(status);
        expect(result.body).toEqual(body);
        expect(result.nextCalls).toBe(0);
      });
    }

    it("does not leak the underlying error message to the client", async () => {
      jest
        .spyOn(mfaService, "verifyChallenge")
        .mockRejectedValue(new Error("secret detail: db://internal"));

      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": "tok" }, { userId: "user-1" }),
      );

      expect(JSON.stringify(result.body)).not.toContain("db://internal");
    });

    it("calls next() exactly once and writes no response on success", async () => {
      jest.spyOn(mfaService, "verifyChallenge").mockResolvedValue({
        userId: "user-1",
        mfaAtSec: 1,
        freshUntilSec: 2,
      });

      const result = await invoke(
        baseOptions,
        makeReq({ "x-chronopay-mfa": "tok" }, { userId: "user-1" }),
      );

      expect(result.nextCalls).toBe(1);
      expect(result.status).toBeNull();
    });
  });
});

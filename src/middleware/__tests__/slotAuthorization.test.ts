/**
 * Tests for slot delete authorization middleware.
 *
 * Covers the public surface of `src/middleware/slotAuthorization.ts`:
 *   - `SlotDeleteAuth` (exported discriminated-union type + the
 *     `Request.slotDeleteAuth` global augmentation it backs)
 *   - `authorizeSlotDelete` (dual x-chronopay-* / x-user-id header contract)
 *   - `assertSlotDeleteAllowed` (ownership check with intentional
 *     403-for-non-owner vs 404-masking divergence between the two modes)
 *
 * `slotService` is replaced with a stub so the suite is deterministic and
 * never touches the in-memory store, the database or the network. The real
 * `SlotNotFoundError` class is preserved so `instanceof` narrowing inside the
 * middleware behaves exactly as it does in production.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Request, Response, NextFunction } from "express";

const actualSlotService = await import("../../services/slotService.js");

jest.unstable_mockModule("../../services/slotService.js", () => ({
  ...actualSlotService,
  slotService: { findById: jest.fn() },
}));

const { slotService, SlotNotFoundError } = await import("../../services/slotService.js");
const { authorizeSlotDelete, assertSlotDeleteAllowed } = await import("../slotAuthorization.js");
type SlotDeleteAuth = import("../slotAuthorization.js").SlotDeleteAuth;

const findById = slotService.findById as unknown as jest.Mock<() => Promise<unknown>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type HeaderMap = Record<string, string | undefined>;

/** Minimal Express request stub exposing only the header lookup the middleware uses. */
function makeReq(headers: HeaderMap = {}): Request {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized.set(key.toLowerCase(), value);
    }
  }
  return {
    header(name: string): string | undefined {
      return normalized.get(name.toLowerCase());
    },
  } as unknown as Request;
}

interface MockRes extends Response {
  statusCode: number;
  body: unknown;
}

/** Minimal Express response stub that records the first status/body written. */
function makeRes(): MockRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as MockRes;
}

function makeNext(): NextFunction & jest.Mock {
  return jest.fn() as unknown as NextFunction & jest.Mock;
}

const OWNER = "professional-1";
const OTHER = "professional-2";
const SLOT_ID = "slot-1";

function slotOwnedBy(professional: string) {
  return { id: SLOT_ID, professional, startTime: 1, endTime: 2 };
}

beforeEach(() => {
  findById.mockReset();
});

// ─── SlotDeleteAuth type contract ─────────────────────────────────────────────

describe("SlotDeleteAuth", () => {
  it("accepts a chronopay auth shape with a role", () => {
    const auth: SlotDeleteAuth = { mode: "chronopay", userId: "u-1", role: "customer" };
    expect(auth.mode).toBe("chronopay");
  });

  it("accepts a legacy auth shape without a role", () => {
    const auth: SlotDeleteAuth = { mode: "legacy", userId: "u-1" };
    expect(auth.mode).toBe("legacy");
    expect("role" in auth).toBe(false);
  });

  it("narrows on the discriminant", () => {
    const auths: SlotDeleteAuth[] = [
      { mode: "chronopay", userId: "u-1", role: "admin" },
      { mode: "legacy", userId: "u-2" },
    ];
    const chronopay = auths.filter((a) => a.mode === "chronopay");
    const legacy = auths.filter((a) => a.mode === "legacy");
    expect(chronopay).toHaveLength(1);
    expect(legacy).toHaveLength(1);
    // `role` is only reachable on the chronopay branch of the union.
    expect(chronopay[0]?.role).toBe("admin");
  });

  it("augments Express Request with an optional slotDeleteAuth field", () => {
    const req = {} as Request;
    expect(req.slotDeleteAuth).toBeUndefined();
    req.slotDeleteAuth = { mode: "legacy", userId: "u-1" };
    expect(req.slotDeleteAuth?.mode).toBe("legacy");
  });
});

// ─── authorizeSlotDelete — unauthenticated ────────────────────────────────────

describe("authorizeSlotDelete — unauthenticated requests", () => {
  it("returns 401 when no auth headers are present at all", () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required." });
    expect(next).not.toHaveBeenCalled();
    expect(req.slotDeleteAuth).toBeUndefined();
  });

  it("returns 401 when only the chronopay role header is present", () => {
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(makeReq({ "x-chronopay-role": "customer" }), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when the chronopay user id header is an empty string", () => {
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(
      makeReq({ "x-chronopay-user-id": "", "x-chronopay-role": "admin" }),
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required." });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns the un-punctuated legacy 401 message when both legacy headers are empty strings", () => {
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(makeReq({ "x-user-id": "", "x-role": "" }), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when only the legacy role header is present and is not admin", () => {
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(makeReq({ "x-role": "customer" }), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required" });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── authorizeSlotDelete — chronopay mode ─────────────────────────────────────

describe("authorizeSlotDelete — x-chronopay-* mode", () => {
  it("attaches chronopay auth and calls next for a non-admin owner", () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER, "x-chronopay-role": "customer" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "customer",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("defaults the role to 'customer' when the role header is absent", () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "customer",
    });
  });

  it("preserves an explicit non-admin role verbatim", () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER, "x-chronopay-role": "professional" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "professional",
    });
  });

  it("bypasses the ownership check for the admin role and attaches no auth", () => {
    const req = makeReq({ "x-chronopay-user-id": OTHER, "x-chronopay-role": "admin" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.slotDeleteAuth).toBeUndefined();
  });

  it("treats 'Admin' (wrong case) as a normal, non-admin role", () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER, "x-chronopay-role": "Admin" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "Admin",
    });
  });

  it("treats a padded 'admin ' as a normal, non-admin role", () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER, "x-chronopay-role": "admin " });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "admin ",
    });
  });

  it("does not trim or reject a whitespace-only user id", () => {
    const req = makeReq({ "x-chronopay-user-id": "   " });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: "   ",
      role: "customer",
    });
  });

  it("prefers chronopay headers over legacy admin headers", () => {
    const req = makeReq({
      "x-chronopay-user-id": OWNER,
      "x-chronopay-role": "customer",
      "x-user-id": OTHER,
      "x-role": "admin",
    });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(req.slotDeleteAuth).toEqual({
      mode: "chronopay",
      userId: OWNER,
      role: "customer",
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects when chronopay headers are empty even if legacy headers are admin", () => {
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(
      makeReq({
        "x-chronopay-user-id": "",
        "x-chronopay-role": "customer",
        "x-user-id": OWNER,
        "x-role": "admin",
      }),
      res,
      next,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "Authentication required." });
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── authorizeSlotDelete — legacy mode ────────────────────────────────────────

describe("authorizeSlotDelete — x-user-id/x-role (legacy) mode", () => {
  it("attaches legacy auth and calls next for a non-admin owner", () => {
    const req = makeReq({ "x-user-id": OWNER, "x-role": "customer" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.slotDeleteAuth).toEqual({ mode: "legacy", userId: OWNER });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("attaches legacy auth when only the user id header is present", () => {
    const req = makeReq({ "x-user-id": OWNER });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({ mode: "legacy", userId: OWNER });
  });

  it("bypasses the ownership check for the legacy admin role", () => {
    const req = makeReq({ "x-user-id": OTHER, "x-role": "admin" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.slotDeleteAuth).toBeUndefined();
  });

  it("bypasses even when the legacy admin role arrives without a user id", () => {
    const req = makeReq({ "x-role": "admin" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.slotDeleteAuth).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it("drops an unrelated legacy role from the recorded auth", () => {
    const req = makeReq({ "x-user-id": OWNER, "x-role": "manager" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());

    expect(req.slotDeleteAuth).toEqual({ mode: "legacy", userId: OWNER });
  });
});

// ─── assertSlotDeleteAllowed ──────────────────────────────────────────────────

describe("assertSlotDeleteAllowed", () => {
  it("returns true without hitting the service when no auth is attached (admin bypass)", async () => {
    const req = makeReq();
    const res = makeRes();

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(true);

    expect(findById).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("returns true for a chronopay owner", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "chronopay", userId: OWNER, role: "customer" };
    const res = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("returns 403 'Insufficient permissions' for a chronopay non-owner", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "chronopay", userId: OTHER, role: "customer" };
    const res = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Insufficient permissions" });
  });

  it("returns true for a legacy owner", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "legacy", userId: OWNER };
    const res = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(true);

    expect(res.body).toBeUndefined();
  });

  it("masks a legacy non-owner as 404 'Slot not found'", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "legacy", userId: OTHER };
    const res = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Slot not found" });
  });

  it("diverges on status code for the same non-owner depending on mode", async () => {
    const chronopayReq = makeReq();
    chronopayReq.slotDeleteAuth = { mode: "chronopay", userId: OTHER, role: "customer" };
    const chronopayRes = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));
    await assertSlotDeleteAllowed(chronopayReq, chronopayRes, SLOT_ID);

    const legacyReq = makeReq();
    legacyReq.slotDeleteAuth = { mode: "legacy", userId: OTHER };
    const legacyRes = makeRes();
    findById.mockResolvedValue(slotOwnedBy(OWNER));
    await assertSlotDeleteAllowed(legacyReq, legacyRes, SLOT_ID);

    expect(chronopayRes.statusCode).toBe(403);
    expect(legacyRes.statusCode).toBe(404);
  });

  it("returns 404 'Slot not found' when the service raises SlotNotFoundError", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "chronopay", userId: OWNER, role: "customer" };
    const res = makeRes();
    findById.mockRejectedValue(new SlotNotFoundError(SLOT_ID));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Slot not found" });
  });

  it("returns 404 for a SlotNotFoundError raised by a legacy non-owner lookup", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "legacy", userId: OTHER };
    const res = makeRes();
    findById.mockRejectedValue(new SlotNotFoundError(999));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Slot not found" });
  });

  it("rethrows unexpected service errors and writes no response", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "chronopay", userId: OWNER, role: "customer" };
    const res = makeRes();
    const boom = new Error("db exploded");
    findById.mockRejectedValue(boom);

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).rejects.toBe(boom);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("passes the slot id through to the service exactly once", async () => {
    const req = makeReq();
    req.slotDeleteAuth = { mode: "legacy", userId: OWNER };
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await assertSlotDeleteAllowed(req, makeRes(), "42");

    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith("42");
  });

  it("does not mutate the attached auth", async () => {
    const req = makeReq();
    const auth: SlotDeleteAuth = { mode: "chronopay", userId: OTHER, role: "customer" };
    req.slotDeleteAuth = auth;
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await assertSlotDeleteAllowed(req, makeRes(), SLOT_ID);

    expect(req.slotDeleteAuth).toEqual(auth);
  });
});

// ─── State transitions across the two entry points ────────────────────────────

describe("authorizeSlotDelete → assertSlotDeleteAllowed state transitions", () => {
  it("unauthenticated → short-circuits with 401 and never reaches the guard", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.slotDeleteAuth).toBeUndefined();
    // routes/slots.ts only calls the guard when slotDeleteAuth is set.
    if (req.slotDeleteAuth) {
      await assertSlotDeleteAllowed(req, res, SLOT_ID);
    }
    expect(findById).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("admin → no auth attached → guard allows without a lookup", async () => {
    const req = makeReq({ "x-chronopay-user-id": OTHER, "x-chronopay-role": "admin" });
    const res = makeRes();
    const next = makeNext();

    authorizeSlotDelete(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.slotDeleteAuth).toBeUndefined();

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(true);
    expect(findById).not.toHaveBeenCalled();
  });

  it("chronopay owner → auth attached → guard allows and writes nothing", async () => {
    const req = makeReq({ "x-chronopay-user-id": OWNER, "x-chronopay-role": "customer" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());
    expect(req.slotDeleteAuth).toEqual({ mode: "chronopay", userId: OWNER, role: "customer" });

    findById.mockResolvedValue(slotOwnedBy(OWNER));
    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBeUndefined();
  });

  it("chronopay non-owner → auth attached → guard stops with 403", async () => {
    const req = makeReq({ "x-chronopay-user-id": OTHER, "x-chronopay-role": "customer" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());
    findById.mockResolvedValue(slotOwnedBy(OWNER));

    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Insufficient permissions" });
  });

  it("legacy non-owner → auth attached → guard masks with 404", async () => {
    const req = makeReq({ "x-user-id": OTHER, "x-role": "customer" });
    const res = makeRes();

    authorizeSlotDelete(req, res, makeNext());
    expect(req.slotDeleteAuth).toEqual({ mode: "legacy", userId: OTHER });

    findById.mockResolvedValue(slotOwnedBy(OWNER));
    await expect(assertSlotDeleteAllowed(req, res, SLOT_ID)).resolves.toBe(false);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Slot not found" });
  });

  it("keeps per-request auth isolated across concurrent requests", async () => {
    const ownerReq = makeReq({ "x-user-id": OWNER });
    const otherReq = makeReq({ "x-user-id": OTHER });
    const ownerRes = makeRes();
    const otherRes = makeRes();

    authorizeSlotDelete(ownerReq, ownerRes, makeNext());
    authorizeSlotDelete(otherReq, otherRes, makeNext());

    expect(ownerReq.slotDeleteAuth).toEqual({ mode: "legacy", userId: OWNER });
    expect(otherReq.slotDeleteAuth).toEqual({ mode: "legacy", userId: OTHER });

    findById.mockResolvedValue(slotOwnedBy(OWNER));
    const [ownerAllowed, otherAllowed] = await Promise.all([
      assertSlotDeleteAllowed(ownerReq, ownerRes, SLOT_ID),
      assertSlotDeleteAllowed(otherReq, otherRes, SLOT_ID),
    ]);

    expect(ownerAllowed).toBe(true);
    expect(otherAllowed).toBe(false);
    expect(ownerRes.body).toBeUndefined();
    expect(otherRes.statusCode).toBe(404);
  });
});

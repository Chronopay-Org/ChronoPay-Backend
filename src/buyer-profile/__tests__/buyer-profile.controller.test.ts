/**
 * Focused behavior coverage for BuyerProfileController (issue #1003).
 *
 * The routes suite exercises the controller through HTTP; this suite pins the
 * controller's own public contract directly: authentication/authorization
 * guards, status codes, response envelopes and the state transitions between
 * the success and failure paths of every handler.
 */

import { jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  BuyerProfileController,
  buyerProfileController,
} from "../buyer-profile.controller.js";
import { buyerProfileService } from "../buyer-profile.service.js";
import type { CreateBuyerProfileData } from "../types/buyer-profile.types.js";

type MockResponse = Response & {
  status: any;
  json: any;
  statusCode?: number;
  body?: any;
};

function makeResponse(): MockResponse {
  const res: any = { statusCode: undefined, body: undefined };

  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload: unknown) => {
    res.body = payload;
    return res;
  });

  return res as MockResponse;
}

function makeRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    user: { id: "user-1", role: "user" },
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function input(overrides: Partial<CreateBuyerProfileData> = {}): CreateBuyerProfileData {
  return {
    userId: "user-1",
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    phoneNumber: "+15551234567",
    ...overrides,
  };
}

describe("BuyerProfileController", () => {
  let controller: BuyerProfileController;

  beforeEach(async () => {
    controller = new BuyerProfileController();
    await buyerProfileService.clearAll();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("create", () => {
    it("returns 401 when there is no authenticated user", async () => {
      const res = makeResponse();
      await controller.create(makeRequest({ user: undefined }), res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ success: false, error: "Authentication required" });
    });

    it("returns 401 when the user identity is missing", async () => {
      const res = makeResponse();
      await controller.create(makeRequest({ user: { id: 42 } }), res);

      expect(res.statusCode).toBe(401);
      expect(res.body).toMatchObject({ success: false, message: "User identity is missing" });
    });

    it("creates the profile and returns 201", async () => {
      const res = makeResponse();
      await controller.create(
        makeRequest({ user: { id: "user-1", role: "user" }, body: input() }),
        res,
      );

      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({
        success: true,
        message: "Buyer profile created successfully",
        data: { userId: "user-1", email: "ada@example.com" },
      });
    });

    it("maps a duplicate profile to 409", async () => {
      await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.create(
        makeRequest({ user: { id: "user-1", role: "user" }, body: input() }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({
        success: false,
        error: "Conflict",
        message: "User already has a buyer profile",
      });
    });

    it("maps a duplicate email to 409 and hides unexpected errors behind 500", async () => {
      await buyerProfileService.create(input({ userId: "owner" }));

      const conflict = makeResponse();
      await controller.create(
        makeRequest({
          user: { id: "user-2", role: "user" },
          body: input({ userId: "user-2" }),
        }),
        conflict,
      );
      expect(conflict.statusCode).toBe(409);
      expect(conflict.body.message).toBe("Email is already in use");

      jest
        .spyOn(buyerProfileService, "create")
        .mockRejectedValueOnce(new Error("database exploded"));
      const serverError = makeResponse();
      await controller.create(
        makeRequest({
          user: { id: "user-3", role: "user" },
          body: input({ userId: "user-3", email: "user-3@example.com" }),
        }),
        serverError,
      );
      expect(serverError.statusCode).toBe(500);
      expect(serverError.body.message).not.toContain("database exploded");
    });
  });

  describe("getMyProfile", () => {
    it("returns 401 without an authenticated user", async () => {
      const res = makeResponse();
      await controller.getMyProfile(makeRequest({ user: undefined }), res);
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 when the user has no profile", async () => {
      const res = makeResponse();
      await controller.getMyProfile(makeRequest({ user: { id: "nobody", role: "user" } }), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toMatchObject({ success: false, error: "Not found" });
    });

    it("returns the current user's profile", async () => {
      await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.getMyProfile(makeRequest({ user: { id: "user-1", role: "user" } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { userId: "user-1" } });
    });
  });

  describe("getById", () => {
    it("returns 401 without an authenticated user", async () => {
      const res = makeResponse();
      await controller.getById(makeRequest({ user: undefined, params: { id: "x" } }), res);
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for an unknown profile", async () => {
      const res = makeResponse();
      await controller.getById(makeRequest({ params: { id: "missing" } }), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toMatchObject({ success: false, message: "Profile not found" });
    });

    it("forbids a non-owner non-admin and allows an admin", async () => {
      const profile = await buyerProfileService.create(input());

      const forbidden = makeResponse();
      await controller.getById(
        makeRequest({ user: { id: "someone-else", role: "user" }, params: { id: profile.id } }),
        forbidden,
      );
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body.error).toBe("Access denied");

      const asAdmin = makeResponse();
      await controller.getById(
        makeRequest({ user: { id: "admin-1", role: "admin" }, params: { id: profile.id } }),
        asAdmin,
      );
      expect(asAdmin.statusCode).toBe(200);
      expect(asAdmin.body.data.id).toBe(profile.id);
    });
  });

  describe("list", () => {
    it("returns 401 without a user and 403 for non-admins", async () => {
      const anonymous = makeResponse();
      await controller.list(makeRequest({ user: undefined }), anonymous);
      expect(anonymous.statusCode).toBe(401);

      const forbidden = makeResponse();
      await controller.list(makeRequest({ user: { id: "user-1", role: "user" } }), forbidden);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body.error).toBe("Access denied");
    });

    it("returns paginated results for admins and parses query filters", async () => {
      await buyerProfileService.create(input({ userId: "ada", fullName: "Ada Lovelace" }));
      await buyerProfileService.create(
        input({ userId: "grace", fullName: "Grace Hopper", email: "grace@example.com" }),
      );

      const res = makeResponse();
      await controller.list(
        makeRequest({
          user: { id: "admin-1", role: "admin" },
          query: { userId: "grace", page: "1", limit: "5" },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        pagination: { page: 1, limit: 5, total: 1 },
      });
      expect(res.body.data).toHaveLength(1);
    });

    it("returns 500 when listing fails unexpectedly", async () => {
      jest
        .spyOn(buyerProfileService, "list")
        .mockRejectedValueOnce(new Error("boom"));

      const res = makeResponse();
      await controller.list(makeRequest({ user: { id: "admin-1", role: "admin" } }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body.message).not.toContain("boom");
    });
  });

  describe("update", () => {
    it("returns 401 without a user and 404 for an unknown profile", async () => {
      const anonymous = makeResponse();
      await controller.update(makeRequest({ user: undefined, params: { id: "x" } }), anonymous);
      expect(anonymous.statusCode).toBe(401);

      const missing = makeResponse();
      await controller.update(makeRequest({ params: { id: "missing" } }), missing);
      expect(missing.statusCode).toBe(404);
    });

    it("forbids editing another user's profile", async () => {
      const profile = await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.update(
        makeRequest({
          user: { id: "intruder", role: "user" },
          params: { id: profile.id },
          body: { fullName: "Hacked" },
        }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("Access denied");
    });

    it("updates the owner's profile and returns 200", async () => {
      const profile = await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.update(
        makeRequest({
          user: { id: "user-1", role: "user" },
          params: { id: profile.id },
          body: { fullName: "Ada Byron" },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { fullName: "Ada Byron" } });
    });

    it("maps a duplicate email to 409", async () => {
      const first = await buyerProfileService.create(input({ userId: "user-1" }));
      await buyerProfileService.create(
        input({ userId: "user-2", email: "second@example.com" }),
      );

      const res = makeResponse();
      await controller.update(
        makeRequest({
          user: { id: "user-1", role: "user" },
          params: { id: first.id },
          body: { email: "second@example.com" },
        }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ success: false, error: "Conflict" });
    });
  });

  describe("delete", () => {
    it("returns 401 without a user and 404 for an unknown profile", async () => {
      const anonymous = makeResponse();
      await controller.delete(makeRequest({ user: undefined, params: { id: "x" } }), anonymous);
      expect(anonymous.statusCode).toBe(401);

      const missing = makeResponse();
      await controller.delete(makeRequest({ params: { id: "missing" } }), missing);
      expect(missing.statusCode).toBe(404);
    });

    it("forbids deleting another user's profile", async () => {
      const profile = await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.delete(
        makeRequest({ user: { id: "intruder", role: "user" }, params: { id: profile.id } }),
        res,
      );

      expect(res.statusCode).toBe(403);
      expect(await buyerProfileService.getById(profile.id)).not.toBeNull();
    });

    it("soft-deletes the owner's profile and reports success", async () => {
      const profile = await buyerProfileService.create(input());

      const res = makeResponse();
      await controller.delete(
        makeRequest({ user: { id: "user-1", role: "user" }, params: { id: profile.id } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(await buyerProfileService.getById(profile.id)).toBeNull();
    });
  });

  it("exports a shared singleton instance", () => {
    expect(buyerProfileController).toBeInstanceOf(BuyerProfileController);
  });
});

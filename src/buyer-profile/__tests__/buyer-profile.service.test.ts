/**
 * Regression coverage for BuyerProfileService failure handling (issue #1005).
 *
 * Pins the error/empty-result contracts that callers (controller and routes)
 * depend on:
 *   - create() rejects with "User already has a buyer profile"
 *   - create() rejects with "Email is already in use"
 *   - getById()/getByUserId()/getByEmail() return null for unknown or deleted
 *     profiles
 *   - update()/delete() reject when the profile cannot be found
 *
 * The neighbouring normal paths and boundary inputs (case-insensitive email,
 * duplicate detection after a soft delete, pagination clamping) are covered so
 * the failure paths cannot silently drift.
 */

import { BuyerProfileService } from "../buyer-profile.service.js";
import type { CreateBuyerProfileData } from "../types/buyer-profile.types.js";

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the promise to reject");
}

function profileInput(overrides: Partial<CreateBuyerProfileData> = {}): CreateBuyerProfileData {
  return {
    userId: "user-1",
    fullName: "Ada Lovelace",
    email: "Ada@Example.com",
    phoneNumber: "+15551234567",
    ...overrides,
  };
}

describe("BuyerProfileService", () => {
  let service: BuyerProfileService;

  beforeEach(async () => {
    service = new BuyerProfileService();
    // The store is module-level; make every test independent.
    await service.clearAll();
  });

  describe("create", () => {
    it("creates a profile, lowercasing the email and defaulting deletedAt", async () => {
      const profile = await service.create(profileInput());

      expect(profile.id).toEqual(expect.any(String));
      expect(profile.userId).toBe("user-1");
      expect(profile.email).toBe("ada@example.com");
      expect(profile.deletedAt).toBeNull();
      expect(profile.createdAt).toBeInstanceOf(Date);

      // Indexes are populated so the lookup paths work immediately.
      expect(await service.getByUserId("user-1")).toEqual(profile);
      expect(await service.getByEmail("ADA@example.com")).toEqual(profile);
    });

    it("rejects a second profile for the same user", async () => {
      await service.create(profileInput());
      const duplicateUser = await captureError(
        service.create(profileInput({ email: "other@example.com" })),
      );

      expect(duplicateUser).toBeInstanceOf(Error);
      expect(duplicateUser.message).toBe("User already has a buyer profile");
      // The failed create must not have leaked a second row.
      expect(await service.count()).toBe(1);
    });

    it("rejects a duplicate email case-insensitively", async () => {
      await service.create(profileInput());
      const duplicateEmail = await captureError(
        service.create(profileInput({ userId: "user-2", email: "ADA@EXAMPLE.COM" })),
      );

      expect(duplicateEmail).toBeInstanceOf(Error);
      expect(duplicateEmail.message).toBe("Email is already in use");
      expect(await service.count()).toBe(1);
    });
  });

  describe("getById / getByUserId / getByEmail", () => {
    it("returns null for an unknown id", async () => {
      expect(await service.getById("does-not-exist")).toBeNull();
    });

    it("returns null for an unknown user and email", async () => {
      expect(await service.getByUserId("nobody")).toBeNull();
      expect(await service.getByEmail("nobody@example.com")).toBeNull();
    });

    it("returns null once a profile has been soft-deleted", async () => {
      const profile = await service.create(profileInput());
      await service.delete(profile.id);

      expect(await service.getById(profile.id)).toBeNull();
      expect(await service.getByUserId(profile.userId)).toBeNull();
      expect(await service.getByEmail(profile.email)).toBeNull();
    });
  });

  describe("update", () => {
    it("rejects when the profile does not exist", async () => {
      const failure = await captureError(service.update("missing", { fullName: "Someone" }));

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe("Profile not found");
    });

    it("rejects when the new email belongs to another profile", async () => {
      const first = await service.create(profileInput());
      await service.create(profileInput({ userId: "user-2", email: "second@example.com" }));

      const failure = await captureError(
        service.update(first.id, { email: "second@example.com" }),
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe("Email is already in use by another profile");
      // The original email index entry is preserved on rejection.
      expect(await service.getByEmail("ada@example.com")).toEqual(first);
    });

    it("updates the profile and moves the email index on success", async () => {
      const profile = await service.create(profileInput());

      const updated = await service.update(profile.id, {
        fullName: "Ada Byron",
        email: "ada.byron@example.com",
      });

      expect(updated.fullName).toBe("Ada Byron");
      expect(updated.email).toBe("ada.byron@example.com");
      expect(await service.getByEmail("ada@example.com")).toBeNull();
      expect(await service.getByEmail("ada.byron@example.com")).toEqual(updated);
    });
  });

  describe("delete", () => {
    it("rejects when the profile does not exist", async () => {
      const failure = await captureError(service.delete("missing"));

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe("Profile not found");
    });

    it("soft-deletes the profile and clears the indexes", async () => {
      const profile = await service.create(profileInput());

      await service.delete(profile.id);

      expect(await service.count()).toBe(0);
      expect(await service.userHasProfile(profile.userId)).toBe(false);
    });
  });

  describe("list", () => {
    it("excludes soft-deleted profiles and clamps pagination inputs", async () => {
      const keep = await service.create(profileInput({ userId: "keep" }));
      const drop = await service.create(
        profileInput({ userId: "drop", email: "drop@example.com" }),
      );
      await service.delete(drop.id);

      const page = await service.list({}, { page: 0, limit: 999 });

      expect(page.data.map((p) => p.id)).toEqual([keep.id]);
      expect(page.pagination).toEqual({ page: 1, limit: 100, total: 1, totalPages: 1 });
    });

    it("filters by userId, email and partial fullName", async () => {
      await service.create(profileInput({ userId: "ada", fullName: "Ada Lovelace" }));
      await service.create(
        profileInput({ userId: "grace", fullName: "Grace Hopper", email: "grace@example.com" }),
      );

      expect((await service.list({ userId: "grace" })).data).toHaveLength(1);
      expect((await service.list({ email: "ADA@example.com" })).data).toHaveLength(1);
      expect((await service.list({ fullName: "hopper" })).data).toHaveLength(1);
      expect((await service.list({ fullName: "nobody" })).data).toHaveLength(0);
    });
  });

  describe("hardDelete", () => {
    it("removes a profile from the store and indexes", async () => {
      const profile = await service.create(profileInput());

      await service.hardDelete(profile.id);

      expect(await service.count()).toBe(0);
      expect(await service.getById(profile.id)).toBeNull();
      expect(await service.userHasProfile(profile.userId)).toBe(false);
    });

    it("is a no-op for an unknown id", async () => {
      await expect(service.hardDelete("missing")).resolves.toBeUndefined();
    });
  });
});

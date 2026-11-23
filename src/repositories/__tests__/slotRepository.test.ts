/**
 * slotRepository.test.ts
 *
 * Regression coverage for SecondaryListingInput failure handling.
 * Tests focus on validation errors in createSecondaryListing and boundary conditions.
 */

import {
  createSecondaryListing,
  getSecondaryListingBySlotId,
  expireSecondaryListings,
  __test__clearSlots,
  type SecondaryListingInput,
} from "../slotRepository.js";

describe("slotRepository - SecondaryListingInput validation", () => {
  beforeEach(() => {
    __test__clearSlots();
  });

  describe("createSecondaryListing - ownerId validation", () => {
    it("throws when ownerId is missing (empty string)", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000, // 1 day from now
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "")
      ).rejects.toThrow("ownerId is required");
    });

    it("throws when ownerId is null or undefined", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, null as any)
      ).rejects.toThrow("ownerId is required");

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, undefined as any)
      ).rejects.toThrow("ownerId is required");
    });

    it("throws when ownerId is only whitespace", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "   ")
      ).rejects.toThrow("ownerId is required");
    });

    it("accepts valid ownerId", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.ownerId).toBe("buyer-1");
      expect(listing.state).toBe("active");
    });

    it("trims whitespace from ownerId", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "  buyer-1  "
      );

      expect(listing.ownerId).toBe("buyer-1");
    });
  });

  describe("createSecondaryListing - priceFloorCents validation", () => {
    it("throws when priceFloorCents is zero", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 0,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("priceFloorCents must be a positive integer");
    });

    it("throws when priceFloorCents is negative", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: -100,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("priceFloorCents must be a positive integer");
    });

    it("throws when priceFloorCents is not an integer (float)", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 99.99,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("priceFloorCents must be a positive integer");
    });

    it("throws when priceFloorCents is NaN", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: NaN,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("priceFloorCents must be a positive integer");
    });

    it("throws when priceFloorCents is Infinity", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: Infinity,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("priceFloorCents must be a positive integer");
    });

    it("accepts minimum valid priceFloorCents (1 cent)", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.priceFloorCents).toBe(1);
    });

    it("accepts large valid priceFloorCents values", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 999999999,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.priceFloorCents).toBe(999999999);
    });
  });

  describe("createSecondaryListing - expiresAt validation", () => {
    it("throws when expiresAt is in the past", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() - 1000, // 1 second ago
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("expiresAt must be a future unix timestamp in ms");
    });

    it("throws when expiresAt equals current time", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now,
        supplierConsent: true,
      };

      // Mock Date.now to ensure consistency
      const originalNow = Date.now;
      Date.now = () => now;

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("expiresAt must be a future unix timestamp in ms");

      Date.now = originalNow;
    });

    it("throws when expiresAt is not a finite number", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Infinity,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("expiresAt must be a future unix timestamp in ms");
    });

    it("throws when expiresAt is NaN", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: NaN,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("expiresAt must be a future unix timestamp in ms");
    });

    it("accepts expiresAt 1ms in the future (boundary)", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now + 1,
        supplierConsent: true,
      };

      const originalNow = Date.now;
      Date.now = () => now;

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.expiresAt).toBe(now + 1);
      Date.now = originalNow;
    });

    it("accepts expiresAt far in the future", async () => {
      const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year from now
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: farFuture,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.expiresAt).toBe(farFuture);
    });
  });

  describe("createSecondaryListing - supplierConsent validation", () => {
    it("throws when supplierConsent is false", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: false,
      };

      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("Supplier consent is required before a slot can be listed for resale");
    });

    it("accepts supplierConsent when true", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.supplierConsent).toBe(true);
    });
  });

  describe("createSecondaryListing - slot existence validation", () => {
    it("throws when slot does not exist", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await expect(
        createSecondaryListing("slot-nonexistent", input, "buyer-1")
      ).rejects.toThrow("Slot slot-nonexistent not found");
    });

    it("accepts valid slot IDs", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.slotId).toBe("slot-11111111-1111-4111-8111-111111111111");
    });
  });

  describe("createSecondaryListing - duplicate listing prevention", () => {
    it("throws when listing already exists for the slot", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      // Create first listing
      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      // Attempt to create duplicate
      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", input, "buyer-1")
      ).rejects.toThrow("A listing already exists for slot slot-11111111-1111-4111-8111-111111111111");
    });

    it("allows listings for different slots", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing1 = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const listing2 = await createSecondaryListing(
        "slot-22222222-2222-4222-8222-222222222222",
        input,
        "buyer-2"
      );

      expect(listing1.slotId).toBe("slot-11111111-1111-4111-8111-111111111111");
      expect(listing2.slotId).toBe("slot-22222222-2222-4222-8222-222222222222");
    });
  });

  describe("createSecondaryListing - success paths", () => {
    it("creates a valid secondary listing with all required fields", async () => {
      const now = Date.now();
      const expiresAt = now + 86400000;
      const input: SecondaryListingInput = {
        priceFloorCents: 5000,
        expiresAt,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing.id).toBeDefined();
      expect(listing.slotId).toBe("slot-11111111-1111-4111-8111-111111111111");
      expect(listing.ownerId).toBe("buyer-1");
      expect(listing.priceFloorCents).toBe(5000);
      expect(listing.expiresAt).toBe(expiresAt);
      expect(listing.supplierConsent).toBe(true);
      expect(listing.state).toBe("active");
      expect(listing.createdAt).toBeDefined();
      expect(listing.updatedAt).toBeDefined();
    });

    it("generates unique listing IDs", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing1 = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const listing2 = await createSecondaryListing(
        "slot-22222222-2222-4222-8222-222222222222",
        input,
        "buyer-2"
      );

      expect(listing1.id).not.toBe(listing2.id);
    });

    it("stores listing so it can be retrieved", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const created = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const retrieved = getSecondaryListingBySlotId("slot-11111111-1111-4111-8111-111111111111");
      expect(retrieved).toEqual(created);
    });

    it("sets timestamps to current time", async () => {
      const before = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );
      const after = Date.now();

      const createdTime = new Date(listing.createdAt).getTime();
      const updatedTime = new Date(listing.updatedAt).getTime();

      expect(createdTime).toBeGreaterThanOrEqual(before);
      expect(createdTime).toBeLessThanOrEqual(after);
      expect(updatedTime).toBeGreaterThanOrEqual(before);
      expect(updatedTime).toBeLessThanOrEqual(after);
    });
  });

  describe("getSecondaryListingBySlotId", () => {
    it("returns undefined when no listing exists", () => {
      const result = getSecondaryListingBySlotId("slot-nonexistent");
      expect(result).toBeUndefined();
    });

    it("returns the listing when it exists", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const result = getSecondaryListingBySlotId("slot-11111111-1111-4111-8111-111111111111");
      expect(result).toBeDefined();
      expect(result?.slotId).toBe("slot-11111111-1111-4111-8111-111111111111");
    });
  });

  describe("expireSecondaryListings", () => {
    it("expires listings when expiresAt is reached", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now + 1000, // Expires in 1 second
        supplierConsent: true,
      };

      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const expired = await expireSecondaryListings(now + 2000); // 2 seconds later
      expect(expired).toHaveLength(1);
      expect(expired[0].state).toBe("expired");
      expect(expired[0].slotId).toBe("slot-11111111-1111-4111-8111-111111111111");
    });

    it("does not expire future listings", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now + 86400000, // Expires in 1 day
        supplierConsent: true,
      };

      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const expired = await expireSecondaryListings(now + 1000); // 1 second later
      expect(expired).toHaveLength(0);
    });

    it("expires multiple listings at different times", async () => {
      const now = Date.now();
      
      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        {
          priceFloorCents: 1000,
          expiresAt: now + 1000,
          supplierConsent: true,
        },
        "buyer-1"
      );

      await createSecondaryListing(
        "slot-22222222-2222-4222-8222-222222222222",
        {
          priceFloorCents: 2000,
          expiresAt: now + 5000,
          supplierConsent: true,
        },
        "buyer-2"
      );

      const expiredFirst = await expireSecondaryListings(now + 2000);
      expect(expiredFirst).toHaveLength(1);
      expect(expiredFirst[0].slotId).toBe("slot-11111111-1111-4111-8111-111111111111");

      const expiredSecond = await expireSecondaryListings(now + 6000);
      expect(expiredSecond).toHaveLength(1);
      expect(expiredSecond[0].slotId).toBe("slot-22222222-2222-4222-8222-222222222222");
    });

    it("updates the updatedAt timestamp when expiring", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now + 1000,
        supplierConsent: true,
      };

      const created = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      const expired = await expireSecondaryListings(now + 2000);
      expect(expired[0].updatedAt).not.toBe(created.updatedAt);
    });

    it("does not expire already expired listings", async () => {
      const now = Date.now();
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: now + 1000,
        supplierConsent: true,
      };

      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      // Expire once
      await expireSecondaryListings(now + 2000);

      // Try to expire again
      const expiredSecond = await expireSecondaryListings(now + 3000);
      expect(expiredSecond).toHaveLength(0);
    });
  });

  describe("__test__clearSlots", () => {
    it("clears all secondary listings", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      await createSecondaryListing(
        "slot-22222222-2222-4222-8222-222222222222",
        input,
        "buyer-2"
      );

      __test__clearSlots();

      expect(getSecondaryListingBySlotId("slot-11111111-1111-4111-8111-111111111111")).toBeUndefined();
      expect(getSecondaryListingBySlotId("slot-22222222-2222-4222-8222-222222222222")).toBeUndefined();
    });
  });

  describe("Combined validation scenarios", () => {
    it("validates all fields before creating listing", async () => {
      // All fields invalid
      const badInput: SecondaryListingInput = {
        priceFloorCents: -1,
        expiresAt: Date.now() - 1000,
        supplierConsent: false,
      };

      // Should fail on first validation (ownerId)
      await expect(
        createSecondaryListing("slot-11111111-1111-4111-8111-111111111111", badInput, "")
      ).rejects.toThrow("ownerId is required");
    });

    it("validates in order: ownerId, priceFloorCents, expiresAt, supplierConsent", async () => {
      // Test validation order by fixing one issue at a time
      
      // 1. Fix ownerId, fail on priceFloorCents
      await expect(
        createSecondaryListing(
          "slot-11111111-1111-4111-8111-111111111111",
          { priceFloorCents: 0, expiresAt: Date.now() - 1000, supplierConsent: false },
          "buyer-1"
        )
      ).rejects.toThrow("priceFloorCents must be a positive integer");

      // 2. Fix priceFloorCents, fail on expiresAt
      await expect(
        createSecondaryListing(
          "slot-11111111-1111-4111-8111-111111111111",
          { priceFloorCents: 1000, expiresAt: Date.now() - 1000, supplierConsent: false },
          "buyer-1"
        )
      ).rejects.toThrow("expiresAt must be a future unix timestamp in ms");

      // 3. Fix expiresAt, fail on supplierConsent
      await expect(
        createSecondaryListing(
          "slot-11111111-1111-4111-8111-111111111111",
          { priceFloorCents: 1000, expiresAt: Date.now() + 1000, supplierConsent: false },
          "buyer-1"
        )
      ).rejects.toThrow("Supplier consent is required");
    });

    it("creates listing when all validations pass", async () => {
      const input: SecondaryListingInput = {
        priceFloorCents: 1000,
        expiresAt: Date.now() + 86400000,
        supplierConsent: true,
      };

      const listing = await createSecondaryListing(
        "slot-11111111-1111-4111-8111-111111111111",
        input,
        "buyer-1"
      );

      expect(listing).toBeDefined();
      expect(listing.state).toBe("active");
    });
  });
});

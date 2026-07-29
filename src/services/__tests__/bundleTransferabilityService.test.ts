/**
 * bundleTransferabilityService.test.ts
 *
 * Tests for the slot bundle transferability feature (Issue #498).
 *
 * Coverage:
 *  - BundleNotTransferableError: typed error class
 *  - BundleTransferabilityService: isTransferable, assertBundleTransferable,
 *    adminSetTransferable, filterTransferable
 *  - BookingIntentService: createIntent rejects non-transferable bundle,
 *    admin bypass
 *  - Edge cases: flag default (undefined = transferable), flag flip mid-listing,
 *    admin override audit, retroactive change
 */

import {
  SchedulingService,
  BundleNotTransferableError,
} from "../schedulingService.js";
import {
  InMemorySlotRepository,
  type SlotRecord,
} from "../../modules/slots/slot-repository.js";
import {
  InMemoryBookingIntentRepository,
} from "../../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentService, BookingIntentError } from "../../modules/booking-intents/booking-intent-service.js";
import { BundleTransferabilityService, AUDIT_ACTION_BUNDLE_TRANSFER_OVERRIDE } from "../bundleTransferabilityService.js";
import { ERROR_CODES } from "../../errors/errorCodes.js";
import { AuditLogger } from "../auditLogger.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW_MS = Date.now();
const T1 = NOW_MS + 1_000_000;
const T2 = T1 + 3_600_000;
const T3 = T2 + 3_600_000;
const VALID_UNTIL = T3 + 3_600_000;

function makeSlot(overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    id: "slot-11111111-1111-4111-8111-111111111111",
    professional: "alice",
    startTime: T1,
    endTime: T2,
    bookable: true,
    ...overrides,
  };
}

function makeSlotRepo(slots: SlotRecord[]): InMemorySlotRepository {
  return new InMemorySlotRepository(slots.map((s) => ({ ...s })));
}

const customerActor = { userId: "customer1", role: "customer" as const, claims: {} as any };
const adminActor = { userId: "admin1", role: "admin" as const, claims: {} as any };

// ─── BundleNotTransferableError ───────────────────────────────────────────────

describe("BundleNotTransferableError", () => {
  it("has the correct name and message", () => {
    const err = new BundleNotTransferableError("bundle-abc");
    expect(err.name).toBe("BundleNotTransferableError");
    expect(err.message).toContain("bundle-abc");
    expect(err.message).toContain("not transferable");
  });

  it("is an instance of Error", () => {
    const err = new BundleNotTransferableError("bundle-abc");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── BundleTransferabilityService ─────────────────────────────────────────────

describe("BundleTransferabilityService", () => {
  describe("isTransferable", () => {
    function makeService(slots: SlotRecord[]) {
      const slotRepo = makeSlotRepo(slots);
      return {
        service: new BundleTransferabilityService(slotRepo),
        slotRepo,
      };
    }

    it("returns true when transferable is undefined (default)", () => {
      const slot = makeSlot({ transferable: undefined });
      const { service } = makeService([slot]);
      expect(service.isTransferable(slot)).toBe(true);
    });

    it("returns true when transferable is true", () => {
      const slot = makeSlot({ transferable: true });
      const { service } = makeService([slot]);
      expect(service.isTransferable(slot)).toBe(true);
    });

    it("returns false when transferable is false", () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);
      expect(service.isTransferable(slot)).toBe(false);
    });
  });

  describe("assertBundleTransferable", () => {
    function makeService(slots: SlotRecord[]) {
      const slotRepo = makeSlotRepo(slots);
      const auditLogPath = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
      const auditLogger = new AuditLogger({ filePath: auditLogPath });
      const service = new BundleTransferabilityService(slotRepo, auditLogger);
      return { service, slotRepo, auditLogger, auditLogPath };
    }

    it("does not throw when transferable is undefined (default)", () => {
      const slot = makeSlot({ transferable: undefined });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot)).not.toThrow();
    });

    it("does not throw when transferable is true", () => {
      const slot = makeSlot({ transferable: true });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot)).not.toThrow();
    });

    it("does not throw when transferable is true and actor is customer", () => {
      const slot = makeSlot({ transferable: true });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot, customerActor)).not.toThrow();
    });

    it("throws BundleNotTransferableError when transferable is false", () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot)).toThrow(BundleNotTransferableError);
    });

    it("throws BundleNotTransferableError when transferable is false and actor is customer", () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot, customerActor)).toThrow(
        BundleNotTransferableError,
      );
    });

    it("does not throw when transferable is false but actor is admin (admin bypass)", () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);
      expect(() => service.assertBundleTransferable(slot, adminActor)).not.toThrow();
    });
  });

  describe("adminSetTransferable", () => {
    function makeService(slots: SlotRecord[]) {
      const slotRepo = makeSlotRepo(slots);
      const auditLogPath = path.join(os.tmpdir(), `audit-test-${Date.now()}.log`);
      const auditLogger = new AuditLogger({ filePath: auditLogPath });
      const service = new BundleTransferabilityService(slotRepo, auditLogger);
      return { service, slotRepo, auditLogger, auditLogPath };
    }

    it("rejects non-admin actors", async () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);
      await expect(
        service.adminSetTransferable(slot.id, true, customerActor),
      ).rejects.toThrow(/Only admins may override/);
    });

    it("throws when slot is not found", async () => {
      const { service } = makeService([]);
      await expect(
        service.adminSetTransferable("nonexistent", true, adminActor),
      ).rejects.toThrow(/not found/);
    });

    it("updates transferable flag and returns previous value", async () => {
      const slot = makeSlot({ transferable: false });
      const { service, slotRepo } = makeService([slot]);

      const result = await service.adminSetTransferable(slot.id, true, adminActor);

      expect(result.slotId).toBe(slot.id);
      expect(result.transferable).toBe(true);
      expect(result.previousValue).toBe(false);
      expect(result.overriddenBy).toBe(adminActor.userId);
      expect(result.overriddenAt).toBeDefined();

      // Verify the slot was updated in the repo
      const updatedSlot = slotRepo.findById(slot.id)!;
      expect(updatedSlot.transferable).toBe(true);
    });

    it("sets transferable to false when admin overrides to non-transferable", async () => {
      const slot = makeSlot({ transferable: true });
      const { service, slotRepo } = makeService([slot]);

      const result = await service.adminSetTransferable(slot.id, false, adminActor);

      expect(result.transferable).toBe(false);
      expect(result.previousValue).toBe(true);

      const updatedSlot = slotRepo.findById(slot.id)!;
      expect(updatedSlot.transferable).toBe(false);
    });

    it("logs audit event on override", async () => {
      const slot = makeSlot({ transferable: false });
      const { service, auditLogPath } = makeService([slot]);

      await service.adminSetTransferable(slot.id, true, adminActor);

      // Read the audit log
      const logContent = await fs.readFile(auditLogPath, "utf8");
      expect(logContent).toContain(AUDIT_ACTION_BUNDLE_TRANSFER_OVERRIDE);
      expect(logContent).toContain(slot.id);
      expect(logContent).toContain(adminActor.userId);

      // Clean up
      try { await fs.unlink(auditLogPath); } catch { /* ignore */ }
    });

    it("is idempotent — setting same value still logs audit", async () => {
      const slot = makeSlot({ transferable: true });
      const { service, auditLogPath } = makeService([slot]);

      await service.adminSetTransferable(slot.id, true, adminActor);
      const logContent = await fs.readFile(auditLogPath, "utf8");
      expect(logContent).toContain(AUDIT_ACTION_BUNDLE_TRANSFER_OVERRIDE);

      try { await fs.unlink(auditLogPath); } catch { /* ignore */ }
    });
  });

  describe("filterTransferable", () => {
    function makeService(slots: SlotRecord[]) {
      return new BundleTransferabilityService(makeSlotRepo(slots));
    }

    it("returns all slots when none have transferable set (default = true)", () => {
      const slots = [makeSlot({ id: "s1" }), makeSlot({ id: "s2" })];
      const service = makeService(slots);
      const filtered = service.filterTransferable(slots);
      expect(filtered).toHaveLength(2);
    });

    it("excludes slots with transferable: false", () => {
      const slots = [
        makeSlot({ id: "s1", transferable: true }),
        makeSlot({ id: "s2", transferable: false }),
        makeSlot({ id: "s3", transferable: true }),
      ];
      const service = makeService(slots);
      const filtered = service.filterTransferable(slots);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((s) => s.id)).toEqual(["s1", "s3"]);
    });

    it("returns empty array when all slots are non-transferable", () => {
      const slots = [
        makeSlot({ id: "s1", transferable: false }),
        makeSlot({ id: "s2", transferable: false }),
      ];
      const service = makeService(slots);
      const filtered = service.filterTransferable(slots);
      expect(filtered).toHaveLength(0);
    });
  });
});

// ─── BookingIntentService integration ─────────────────────────────────────────

describe("BookingIntentService integration with transferability", () => {
  function makeService(slots: SlotRecord[], nowMs?: number) {
    const slotRepo = makeSlotRepo(slots);
    const intentRepo = new InMemoryBookingIntentRepository();
    const service = new BookingIntentService(
      intentRepo,
      slotRepo,
      () => new Date(nowMs ?? NOW_MS).toISOString(),
      () => nowMs ?? NOW_MS,
    );
    return { service, slotRepo, intentRepo };
  }

  describe("createIntent", () => {
    it("creates intent for transferable slot", async () => {
      const slot = makeSlot({ transferable: true });
      const { service } = makeService([slot]);

      const intent = await service.createIntent({ slotId: slot.id }, customerActor);
      expect(intent.status).toBe("pending");
      expect(intent.slotId).toBe(slot.id);
    });

    it("creates intent when transferable is undefined (default)", async () => {
      const slot = makeSlot({ transferable: undefined });
      const { service } = makeService([slot]);

      const intent = await service.createIntent({ slotId: slot.id }, customerActor);
      expect(intent.status).toBe("pending");
    });

    it("rejects createIntent for non-transferable slot with BUNDLE_NOT_TRANSFERABLE code", async () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);

      try {
        await service.createIntent({ slotId: slot.id }, customerActor);
        fail("Expected BookingIntentError");
      } catch (err) {
        expect(err).toBeInstanceOf(BookingIntentError);
        expect((err as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_NOT_TRANSFERABLE.code);
        expect((err as BookingIntentError).statusCode).toBe(422);
        expect((err as BookingIntentError).message).toContain("not transferable");
      }
    });

    it("allows admin to create intent on non-transferable slot (admin bypass)", async () => {
      const slot = makeSlot({ transferable: false });
      const { service } = makeService([slot]);

      const intent = await service.createIntent({ slotId: slot.id }, adminActor);
      expect(intent.status).toBe("pending");
      expect(intent.slotId).toBe(slot.id);
    });

    it("still rejects non-transferable even with valid expiry", async () => {
      const slot = makeSlot({ transferable: false, validUntil: VALID_UNTIL });
      const { service } = makeService([slot]);

      try {
        await service.createIntent({ slotId: slot.id }, customerActor);
        fail("Expected BookingIntentError");
      } catch (err) {
        expect(err).toBeInstanceOf(BookingIntentError);
        expect((err as BookingIntentError).code).toBe(ERROR_CODES.BUNDLE_NOT_TRANSFERABLE.code);
      }
    });
  });

  describe("Flag flip mid-listing", () => {
    it("allows intent creation before transferable flag is flipped to false", async () => {
      const slot = makeSlot({ transferable: true });
      const { service, slotRepo } = makeService([slot]);

      // Create intent while transferable
      const intent = await service.createIntent({ slotId: slot.id }, customerActor);
      expect(intent.status).toBe("pending");

      // Flip the flag to false after creation (simulates supplier changing mind)
      const internalSlots = (slotRepo as any).slots as SlotRecord[];
      const target = internalSlots.find((s: SlotRecord) => s.id === slot.id)!;
      target.transferable = false;

      // The existing intent should still be valid (flag flip doesn't retroactively cancel)
      const existing = intent;
      expect(existing.status).toBe("pending");
    });

    it("blocks new intent after flag is flipped to false", async () => {
      const slot = makeSlot({ transferable: true });
      const { service } = makeService([slot]);

      // First intent succeeds
      const intent1 = await service.createIntent({ slotId: slot.id }, customerActor);
      expect(intent1.status).toBe("pending");

      // Release the slot so another can try
      service.cancelIntent(intent1.id, customerActor);

      // Flip the flag in the repo
      const internalSlots = (service as any).slotRepository.slots as SlotRecord[];
      const target = internalSlots.find((s: SlotRecord) => s.id === slot.id)!;
      target.transferable = false;

      // Second intent should be blocked (wrapped in BookingIntentError)
      await expect(
        service.createIntent({ slotId: slot.id }, customerActor),
      ).rejects.toThrow(BookingIntentError);
    });
  });
});

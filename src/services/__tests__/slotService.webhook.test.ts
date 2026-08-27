// @ts-nocheck
import { jest } from "@jest/globals";
import { SlotService, SlotValidationError, SlotNotFoundError } from "../slotService.js";
import { SupplierCalendarSettingStore } from "../supplierCalendarSettingStore.js";
import type { CalendarMode, SlotStatus } from "../../webhooks/dispatch.js";

// ─── Mocks ─────────────────────────────────────────────────────────────────

jest.mock("../../utils/logger.js", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

jest.mock("../../config/timeouts.js", () => ({
  timeoutConfig: {
    http: { webhookMs: 5000 },
    retry: { maxAttempts: 2, baseDelayMs: 10, maxTotalBudgetMs: 5000 },
  },
}));

// ─── Types ─────────────────────────────────────────────────────────────────

interface WebhookCall {
  mode: CalendarMode;
  slot: {
    id: number | string;
    professional: string;
    startTime: number;
    endTime: number;
    status: SlotStatus;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Wait for fire-and-forget webhook promises to settle. */
async function flushWebhooks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("SlotService – Webhook Integration", () => {
  let mockClock: () => Date;
  let webhookCalls: WebhookCall[];
  let mockDispatcher: jest.Mock;
  let service: SlotService;

  beforeEach(() => {
    SupplierCalendarSettingStore.clear();
    mockClock = jest.fn(() => new Date("2026-05-27T10:00:00.000Z"));
    webhookCalls = [];
    mockDispatcher = jest.fn(async (mode: CalendarMode, slot: any) => {
      webhookCalls.push({ mode, slot });
    });
    service = new SlotService(mockClock, undefined, {
      webhookDispatcher: mockDispatcher,
      suppliers: [
        { supplierId: "supplier-1", webhookUrl: "https://s1.example.com/hook" },
        { supplierId: "supplier-2", webhookUrl: "https://s2.example.com/hook" },
      ],
    });

    // Enable both suppliers
    SupplierCalendarSettingStore.setEnabled("supplier-1", true);
    SupplierCalendarSettingStore.setEnabled("supplier-2", true);
  });

  afterEach(() => {
    SupplierCalendarSettingStore.clear();
  });

  describe("createSlot webhook", () => {
    it("should fire webhook with mode 'add' after creating a slot", async () => {
      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(2); // 2 suppliers
      expect(webhookCalls[0].mode).toBe("add");
      expect(webhookCalls[0].slot.professional).toBe("Dr. Smith");
      expect(webhookCalls[0].slot.startTime).toBe(1000);
      expect(webhookCalls[0].slot.endTime).toBe(2000);
      expect(webhookCalls[0].slot.status).toBe("available");
    });

    it("should include the correct slot ID in the webhook", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(webhookCalls[0].slot.id).toBe(slot.id);
    });

    it("should not fire webhook if no suppliers are configured", async () => {
      service.setSuppliers([]);
      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should not fire webhook if dispatcher is not set", async () => {
      service.setWebhookDispatcher(null);
      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should not fire webhook for disabled suppliers", async () => {
      SupplierCalendarSettingStore.setEnabled("supplier-2", false);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      // Only supplier-1 should receive the webhook
      expect(mockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("should not throw if webhook dispatcher fails", async () => {
      mockDispatcher.mockImplementationOnce(async () => {
        throw new Error("dispatch failed");
      });
      mockDispatcher.mockImplementationOnce(async () => {
        throw new Error("dispatch failed");
      });

      expect(() => {
        service.createSlot({
          professional: "Dr. Smith",
          startTime: 1000,
          endTime: 2000,
        });
      }).not.toThrow();

      await flushWebhooks();

      // Slot should still exist
      const found = await service.findById(1);
      expect(found).toBeDefined();
      expect(found.professional).toBe("Dr. Smith");
    });
  });

  describe("updateSlot webhook", () => {
    it("should fire webhook with mode 'update' after updating a slot", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      // Wait for create webhook to complete, then reset
      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      service.updateSlot(slot.id, { startTime: 1200 });

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(2);
      expect(webhookCalls[0].mode).toBe("update");
      expect(webhookCalls[0].slot.startTime).toBe(1200);
      expect(webhookCalls[0].slot.endTime).toBe(2000);
    });

    it("should include updated professional name in webhook", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      service.updateSlot(slot.id, { professional: "Dr. Smith Jr." });

      await flushWebhooks();

      expect(webhookCalls[0].slot.professional).toBe("Dr. Smith Jr.");
    });

    it("should not fire webhook if slot not found", async () => {
      expect(() => service.updateSlot(999, { startTime: 100 })).toThrow(SlotNotFoundError);

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should not fire webhook if validation fails", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      expect(() => service.updateSlot(slot.id, null as any)).toThrow(SlotValidationError);

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("deleteSlot webhook", () => {
    it("should fire webhook with mode 'delete' after deleting a slot", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      await service.deleteSlot(slot.id);

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(2);
      expect(webhookCalls[0].mode).toBe("delete");
      expect(webhookCalls[0].slot.id).toBe(slot.id);
      expect(webhookCalls[0].slot.status).toBe("cancelled");
    });

    it("should not fire webhook if slot not found", async () => {
      await expect(service.deleteSlot(999)).rejects.toThrow(SlotNotFoundError);

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should include slot details in delete webhook", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      await service.deleteSlot(slot.id);

      await flushWebhooks();

      expect(webhookCalls[0].slot.professional).toBe("Dr. Smith");
      expect(webhookCalls[0].slot.startTime).toBe(1000);
      expect(webhookCalls[0].slot.endTime).toBe(2000);
    });
  });

  describe("Supplier opt-in/out", () => {
    it("should not fire webhooks for suppliers that have calendar sync disabled", async () => {
      SupplierCalendarSettingStore.setEnabled("supplier-2", false);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      // Only supplier-1 should receive
      expect(mockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("should fire webhooks when a supplier re-enables calendar sync", async () => {
      SupplierCalendarSettingStore.setEnabled("supplier-2", false);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      expect(mockDispatcher).toHaveBeenCalledTimes(1);

      // Re-enable supplier-2
      SupplierCalendarSettingStore.setEnabled("supplier-2", true);

      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      service.createSlot({
        professional: "Dr. Jones",
        startTime: 3000,
        endTime: 4000,
      });

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(2);
    });

    it("should not fire webhooks after a supplier removes their setting", async () => {
      SupplierCalendarSettingStore.remove("supplier-2");

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("setSuppliers", () => {
    it("should update suppliers list dynamically", async () => {
      service.setSuppliers([
        { supplierId: "s3", webhookUrl: "https://s3.example.com/hook" },
      ]);

      SupplierCalendarSettingStore.setEnabled("s3", true);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).toHaveBeenCalledTimes(1);
    });

    it("should allow clearing all suppliers", async () => {
      service.setSuppliers([]);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("setWebhookDispatcher", () => {
    it("should allow changing the dispatcher", async () => {
      const newDispatcher = jest.fn(async () => {});
      service.setWebhookDispatcher(newDispatcher);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(newDispatcher).toHaveBeenCalledTimes(2);
      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should allow disabling webhooks by setting null", async () => {
      service.setWebhookDispatcher(null);

      service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });
  });

  describe("Transaction rollback guarantee", () => {
    it("should not fire webhook if slot creation throws before completion", async () => {
      // Attempting to create with invalid data should throw
      expect(() => {
        service.createSlot({
          professional: "", // Invalid
          startTime: 1000,
          endTime: 2000,
        });
      }).toThrow(SlotValidationError);

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });

    it("should not fire webhook if slot update throws before completion", async () => {
      const slot = service.createSlot({
        professional: "Dr. Smith",
        startTime: 1000,
        endTime: 2000,
      });

      await flushWebhooks();
      webhookCalls.length = 0;
      mockDispatcher.mockClear();

      expect(() => {
        service.updateSlot(slot.id, { startTime: "invalid" as any });
      }).toThrow(SlotValidationError);

      await flushWebhooks();

      expect(mockDispatcher).not.toHaveBeenCalled();
    });
  });
});

import {
  GdprExportService,
  type GdprProfile,
  type GdprBooking,
  type GdprReceipt,
  type GdprExportArchive,
} from "../gdprExportService.js";
import { InMemoryEphemeralStore } from "../ephemeralStore.js";

const TEST_SECRET = "test-gdpr-export-secret-key-32chars!!!!";

function makeService(
  overrides?: {
    profile?: GdprProfile | null;
    bookings?: GdprBooking[];
    receipts?: GdprReceipt[];
    store?: InMemoryEphemeralStore<any>;
  },
) {
  const store = overrides?.store ?? new InMemoryEphemeralStore<any>();

  const profileProvider = async (_userId: string) => overrides?.profile ?? null;
  const bookingsProvider = async (_userId: string) => overrides?.bookings ?? [];
  const receiptsProvider = async (_userId: string) => overrides?.receipts ?? [];

  const service = new GdprExportService(
    store,
    undefined, // use silent logger
    profileProvider,
    bookingsProvider,
    receiptsProvider,
  );

  return { service, store };
}

describe("GdprExportService", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.CHRONOPAY_GDPR_EXPORT_SECRET = TEST_SECRET;
    process.env.CHRONOPAY_GDPR_EXPORT_TTL_SECONDS = "60";
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  describe("createExport", () => {
    it("returns a download URL and export ID", async () => {
      const { service } = makeService({
        profile: { id: "u1", email: "a@b.com", name: "Alice" },
      });

      const result = await service.createExport("u1", "https://example.com");
      expect(result.downloadUrl).toContain("/api/v1/gdpr/export/download?token=");
      expect(result.exportId).toBeDefined();
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it("bundles profile, bookings, and receipts", async () => {
      const bookings: GdprBooking[] = [
        { id: "b1", slotId: "s1", status: "confirmed", createdAt: "2025-01-01" },
      ];
      const receipts: GdprReceipt[] = [
        { id: "r1", bookingId: "b1", amount: 5000, currency: "USD", fee: 75, status: "paid" },
      ];

      const { service, store } = makeService({
        profile: { id: "u1", email: "a@b.com" },
        bookings,
        receipts,
      });

      const result = await service.createExport("u1", "https://example.com");

      // Verify stored content
      const stored = await store.get(result.exportId);
      expect(stored).toBeDefined();

      const archive: GdprExportArchive = JSON.parse(stored!.content);
      expect(archive.profile?.id).toBe("u1");
      expect(archive.bookings).toHaveLength(1);
      expect(archive.receipts).toHaveLength(1);
      expect(archive.version).toBe("1.0");
      expect(archive.exportedAt).toBeDefined();
    });

    it("throws when signing secret is not configured", async () => {
      delete process.env.CHRONOPAY_GDPR_EXPORT_SECRET;
      const { service } = makeService();

      await expect(service.createExport("u1", "https://example.com"))
        .rejects.toThrow("signing secret is not configured");
    });

    it("handles empty userId gracefully with null profile", async () => {
      const { service, store } = makeService();
      const result = await service.createExport("", "https://example.com");

      const stored = await store.get(result.exportId);
      const archive: GdprExportArchive = JSON.parse(stored!.content);
      expect(archive.profile).toBeNull();
      expect(archive.bookings).toEqual([]);
    });

    it("returns empty profile and arrays when no data", async () => {
      const { service, store } = makeService();
      const result = await service.createExport("u1", "https://example.com");

      const stored = await store.get(result.exportId);
      const archive: GdprExportArchive = JSON.parse(stored!.content);
      expect(archive.profile).toBeNull();
      expect(archive.bookings).toEqual([]);
      expect(archive.receipts).toEqual([]);
    });

    it("includes canceled bookings", async () => {
      const bookings: GdprBooking[] = [
        { id: "b1", slotId: "s1", status: "confirmed" },
        { id: "b2", slotId: "s2", status: "cancelled", cancelledAt: "2025-06-01" },
      ];

      const { service, store } = makeService({ bookings });
      const result = await service.createExport("u1", "https://example.com");

      const stored = await store.get(result.exportId);
      const archive: GdprExportArchive = JSON.parse(stored!.content);
      expect(archive.bookings).toHaveLength(2);
      expect(archive.bookings[1].status).toBe("cancelled");
    });
  });

  describe("getExport", () => {
    it("retrieves a valid export by token", async () => {
      const { service } = makeService({
        profile: { id: "u1", email: "a@b.com" },
      });

      const { downloadUrl } = await service.createExport("u1", "https://example.com");
      const token = new URL(downloadUrl).searchParams.get("token")!;

      const entry = await service.getExport(token);
      expect(entry.content).toBeDefined();
      expect(entry.integrity).toBeDefined();

      const archive: GdprExportArchive = JSON.parse(entry.content);
      expect(archive.profile?.id).toBe("u1");
    });

    it("rejects invalid token", async () => {
      const { service } = makeService();

      await expect(service.getExport("invalid-token"))
        .rejects.toThrow("Invalid export token");
    });

    it("rejects expired token", async () => {
      process.env.CHRONOPAY_GDPR_EXPORT_TTL_SECONDS = "0"; // immediate expiry
      const { service } = makeService({
        profile: { id: "u1", email: "a@b.com" },
      });

      const { downloadUrl } = await service.createExport("u1", "https://example.com");
      const token = new URL(downloadUrl).searchParams.get("token")!;

      // Wait briefly to ensure expiry
      await new Promise((r) => setTimeout(r, 10));

      await expect(service.getExport(token))
        .rejects.toThrow("expired");
    });

    it("validates integrity", async () => {
      const { service, store } = makeService({
        profile: { id: "u1", email: "a@b.com" },
      });

      const { downloadUrl, exportId } = await service.createExport("u1", "https://example.com");
      const token = new URL(downloadUrl).searchParams.get("token")!;

      // Tamper with stored content
      const entry = await store.get(exportId);
      if (entry) {
        await store.set(exportId, {
          ...entry,
          content: entry.content.replace("u1", "hacked"),
        }, 60);
      }

      await expect(service.getExport(token))
        .rejects.toThrow("integrity");
    });

    it("throws when signing secret is not configured", async () => {
      delete process.env.CHRONOPAY_GDPR_EXPORT_SECRET;
      const { service } = makeService();

      await expect(service.getExport("some-token"))
        .rejects.toThrow("signing secret is not configured");
    });
  });

  describe("signed URL security", () => {
    it("tokens are different for different exports", async () => {
      const { service } = makeService({
        profile: { id: "u1", email: "a@b.com" },
      });

      const r1 = await service.createExport("u1", "https://example.com");
      const r2 = await service.createExport("u1", "https://example.com");

      const token1 = new URL(r1.downloadUrl).searchParams.get("token")!;
      const token2 = new URL(r2.downloadUrl).searchParams.get("token")!;

      expect(token1).not.toBe(token2);
    });

    it("token cannot be reused after content tamper", async () => {
      const { service, store } = makeService({
        profile: { id: "u1", email: "a@b.com" },
      });

      const { downloadUrl, exportId } = await service.createExport("u1", "https://example.com");
      const token = new URL(downloadUrl).searchParams.get("token")!;

      // Delete the export (simulates single-use pattern)
      await store.delete(exportId);

      await expect(service.getExport(token))
        .rejects.toThrow("not found");
    });
  });
});

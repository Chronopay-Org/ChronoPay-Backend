import crypto from "node:crypto";
import { EphemeralStore, InMemoryEphemeralStore } from "./ephemeralStore.js";
import { AuditLogger } from "./auditLogger.js";

export interface GdprExportResult {
  downloadUrl: string;
  exportId: string;
  expiresAt: number;
}

export interface GdprProfile {
  id: string;
  email: string;
  name?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface GdprBooking {
  id: string;
  slotId: string;
  status: string;
  note?: string;
  createdAt?: string;
  cancelledAt?: string;
  metadata?: Record<string, unknown>;
}

export interface GdprReceipt {
  id: string;
  bookingId: string;
  amount: number;
  currency: string;
  fee?: number;
  status: string;
  issuedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface GdprExportArchive {
  profile: GdprProfile | null;
  bookings: GdprBooking[];
  receipts: GdprReceipt[];
  exportedAt: string;
  version: string;
}

interface StoredGdprExport {
  content: string;
  expiresAt: number;
  integrity: string;
}

const DEFAULT_EXPORT_TTL_SECONDS = 900; // 15 minutes
const MAX_EXPORT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DOWNLOAD_PATH = "/api/v1/gdpr/export/download";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function buildToken(exportId: string, expiresAt: number, secret: string): string {
  const payload = `${exportId}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

function parseToken(token: string, secret: string): { exportId: string; expiresAt: number } {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid export token");
  }

  const parts = decoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid export token");
  }

  const [exportId, expiresAtString, providedSignature] = parts;
  const expiresAt = Number(expiresAtString);

  if (!exportId || Number.isNaN(expiresAt) || !providedSignature) {
    throw new Error("Invalid export token");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${exportId}:${expiresAt}`, "utf8")
    .digest("hex");

  if (!timingSafeEquals(expectedSignature, providedSignature)) {
    throw new Error("Invalid export token");
  }

  if (Date.now() > expiresAt) {
    throw new Error("Export token expired");
  }

  return { exportId, expiresAt };
}

export type ProfileProvider = (userId: string) => Promise<GdprProfile | null>;
export type BookingsProvider = (userId: string) => Promise<GdprBooking[]>;
export type ReceiptsProvider = (userId: string) => Promise<GdprReceipt[]>;

export class GdprExportService {
  private get ttlSeconds(): number {
    return Number(process.env.CHRONOPAY_GDPR_EXPORT_TTL_SECONDS ?? DEFAULT_EXPORT_TTL_SECONDS);
  }

  private get secret(): string {
    return process.env.CHRONOPAY_GDPR_EXPORT_SECRET || "";
  }

  private get maxExportSize(): number {
    return Number(process.env.CHRONOPAY_GDPR_EXPORT_MAX_BYTES ?? MAX_EXPORT_SIZE_BYTES);
  }

  constructor(
    private readonly store: EphemeralStore<StoredGdprExport> = new InMemoryEphemeralStore<StoredGdprExport>(),
    private readonly logger: AuditLogger = new AuditLogger(),
    private readonly profileProvider: ProfileProvider = async () => null,
    private readonly bookingsProvider: BookingsProvider = async () => [],
    private readonly receiptsProvider: ReceiptsProvider = async () => [],
  ) {}

  public async createExport(userId: string, baseUrl: string): Promise<GdprExportResult> {
    if (!this.secret) {
      throw new Error("GDPR export signing secret is not configured.");
    }

    const exportId = crypto.randomUUID();

    await this.logger.log(
      "gdpr.export.requested",
      {
        method: "POST",
        context: { exportId, userId },
      },
      {
        resource: "/api/v1/gdpr/export",
        status: 200,
      },
    );

    const profile = await this.profileProvider(userId);
    const bookings = await this.bookingsProvider(userId);
    const receipts = await this.receiptsProvider(userId);

    const archive: GdprExportArchive = {
      profile,
      bookings,
      receipts,
      exportedAt: new Date().toISOString(),
      version: "1.0",
    };

    const content = JSON.stringify(archive, null, 2);

    if (Buffer.byteLength(content, "utf8") > this.maxExportSize) {
      throw new Error(
        `Export exceeds maximum size of ${this.maxExportSize} bytes. Use paginated export.`,
      );
    }

    const integrity = sha256Hex(content);
    const expiresAt = Date.now() + this.ttlSeconds * 1000;

    await this.store.set(exportId, { content, expiresAt, integrity }, this.ttlSeconds);

    const token = buildToken(exportId, expiresAt, this.secret);
    const downloadUrl = `${baseUrl}${DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;

    return { downloadUrl, exportId, expiresAt };
  }

  public async getExport(token: string): Promise<StoredGdprExport> {
    if (!this.secret) {
      throw new Error("GDPR export signing secret is not configured.");
    }

    const { exportId } = parseToken(token, this.secret);

    const exportEntry = await this.store.get(exportId);
    if (!exportEntry) {
      throw new Error("Export not found or expired.");
    }

    const computedHash = sha256Hex(exportEntry.content);
    if (!timingSafeEquals(computedHash, exportEntry.integrity)) {
      await this.store.delete(exportId);
      throw new Error("Export integrity validation failed.");
    }

    await this.logger.log(
      "gdpr.export.downloaded",
      {
        method: "GET",
        context: { exportId },
      },
      {
        resource: "/api/v1/gdpr/export/download",
        status: 200,
      },
    );

    return exportEntry;
  }
}

import fs from "fs/promises";
import crypto from "node:crypto";
import { decodeAuditEvent, redactSensitiveData } from "../utils/auditEventValidator.js";
import { AuditLogger } from "./auditLogger.js";
import { EphemeralStore, InMemoryEphemeralStore } from "./ephemeralStore.js";
import { JobQueue } from "./jobQueue.js";

export interface AuditExportResult {
  downloadUrl: string;
  integrity: string;
  expiresAt: number;
}

interface StoredAuditExport {
  content: string;
  integrity: string;
  expiresAt: number;
}

const DEFAULT_EXPORT_TTL_SECONDS = 300;
const DOWNLOAD_PATH = "/api/v1/admin/audit/export/download";

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

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

export class AuditExportService {
  private get ttlSeconds(): number {
    return Number(process.env.CHRONOPAY_AUDIT_EXPORT_TTL_SECONDS ?? DEFAULT_EXPORT_TTL_SECONDS);
  }

  private get secret(): string {
    return process.env.CHRONOPAY_AUDIT_EXPORT_SECRET || "";
  }

  constructor(
    private readonly store: EphemeralStore<StoredAuditExport> = new InMemoryEphemeralStore<StoredAuditExport>(),
    private readonly queue: JobQueue = new JobQueue(),
    private readonly logger: AuditLogger = new AuditLogger(),
  ) {}

  public async createExport(baseUrl: string): Promise<AuditExportResult> {
    if (!this.secret) {
      throw new Error("Audit export signing secret is not configured.");
    }

    return this.queue.enqueue(async () => {
      const exportId = crypto.randomUUID();
      const exportData = await this.buildExportContent();
      const expiresAt = Date.now() + this.ttlSeconds * 1000;
      const integrity = sha256Hex(exportData);
      await this.store.set(exportId, { content: exportData, integrity, expiresAt }, this.ttlSeconds);

      const token = buildToken(exportId, expiresAt, this.secret);
      const downloadUrl = `${baseUrl}${DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;

      await this.logger.log(
        "audit.export.requested",
        { method: "POST", context: { expiresAt, exportId } },
        { resource: "/api/v1/admin/audit/export", status: 200 },
      );

      return { downloadUrl, integrity, expiresAt };
    });
  }

  public async getExport(token: string): Promise<StoredAuditExport> {
    if (!this.secret) {
      throw new Error("Audit export signing secret is not configured.");
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
      "audit.export.downloaded",
      { method: "GET", context: { exportId } },
      { resource: "/api/v1/admin/audit/export/download", status: 200 },
    );

    return exportEntry;
  }

  private async buildExportContent(): Promise<string> {
    let rawFile: string;
    const filePath = this.logger.getLogFilePath();

    try {
      rawFile = await fs.readFile(filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        rawFile = "";
      } else {
        throw error;
      }
    }

    const lines = rawFile.split(/\r?\n/).filter(Boolean);
    const normalized = lines
      .map((line) => {
        try {
          const event = decodeAuditEvent(line);
          return JSON.stringify({
            ...event,
            data: redactSensitiveData(event.data),
          });
        } catch {
          return null;
        }
      })
      .filter((line): line is string => line !== null)
      .join("\n");

    return normalized.length > 0 ? `${normalized}\n` : "";
  }
}

export const auditExportService = new AuditExportService();

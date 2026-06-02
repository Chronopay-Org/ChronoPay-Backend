import fs from "fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AuditLogger } from "../../services/auditLogger.js";
import { AuditExportService } from "../../services/auditExportService.js";
import { InMemoryEphemeralStore } from "../../services/ephemeralStore.js";
import { JobQueue } from "../../services/jobQueue.js";

const EXAMPLE_EVENT = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  eventId: "00000000-0000-4000-8000-000000000000",
  action: "test.event",
  actorIp: "127.0.0.1",
  resource: "/api/test",
  status: 200,
  data: {
    method: "POST",
    body: { message: "hello" },
    context: { userId: "user-1" },
  },
  service: "chronopay-backend",
  environment: "test",
};

function makeToken(exportId: string, expiresAt: number, secret: string): string {
  const payload = `${exportId}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

describe("AuditExportService", () => {
  let tempDir: string;
  let logger: AuditLogger;
  let service: AuditExportService;

  beforeEach(async () => {
    process.env.CHRONOPAY_AUDIT_EXPORT_SECRET = "audit-secret";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "chronopay-audit-export-"));
    const auditLogFile = path.join(tempDir, "audit.log");
    logger = new AuditLogger({ filePath: auditLogFile, environment: "test" });
    await fs.writeFile(auditLogFile, `${JSON.stringify(EXAMPLE_EVENT)}\n`, "utf8");
    service = new AuditExportService(
      new InMemoryEphemeralStore(),
      new JobQueue(),
      logger,
    );
  });

  afterEach(async () => {
    delete process.env.CHRONOPAY_AUDIT_EXPORT_SECRET;
    delete process.env.CHRONOPAY_AUDIT_EXPORT_TTL_SECONDS;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("creates a signed export and returns a short-lived download URL with integrity hash", async () => {
    const result = await service.createExport("https://example.com");

    expect(result.downloadUrl).toContain("https://example.com/api/v1/admin/audit/export/download?token=");
    expect(result.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns the same content hash on download and preserves file payload", async () => {
    const { downloadUrl, integrity } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token");
    expect(token).toBeTruthy();

    const exportEntry = await service.getExport(token!);
    expect(exportEntry.integrity).toBe(integrity);
    expect(exportEntry.content).toContain("test.event");
    expect(exportEntry.content).toContain("hello");
  });

  it("fails integrity validation when stored export content is tampered", async () => {
    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const exportId = Buffer.from(token, "base64url").toString("utf8").split(":")[0];
    const store = (service as any).store as InMemoryEphemeralStore<any>;
    const entry = await store.get(exportId);
    expect(entry).toBeDefined();
    entry.content = entry.content.replace("hello", "tampered");
    await store.set(exportId, entry, 300);

    await expect(service.getExport(token)).rejects.toThrow("Export integrity validation failed");
  });

  it("rejects an expired signed token", async () => {
    const { downloadUrl } = await service.createExport("https://example.com");
    const token = new URL(downloadUrl).searchParams.get("token")!;
    const [exportId] = Buffer.from(token, "base64url").toString("utf8").split(":");
    const expiredToken = makeToken(exportId, Date.now() - 1000, process.env.CHRONOPAY_AUDIT_EXPORT_SECRET!);

    await expect(service.getExport(expiredToken)).rejects.toThrow("Export token expired");
  });

  it("rejects a malformed token", async () => {
    await expect(service.getExport("not-a-valid-token")).rejects.toThrow("Invalid export token");
  });
});

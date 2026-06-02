import fs from "fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../../app.js";

const app = createApp({ enableContentNegotiation: false });
const LOG_DIR = path.join(process.cwd(), "logs");
const AUDIT_LOG_PATH = path.join(LOG_DIR, "audit.log");

const AUDIT_EVENT = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  eventId: "00000000-0000-4000-8000-000000000000",
  action: "admin.test",
  actorIp: "127.0.0.1",
  resource: "/api/v1/admin/audit/export",
  status: 200,
  data: {
    method: "POST",
    body: { secret: "supersecret" },
    context: { actor: "admin" },
  },
  service: "chronopay-backend",
  environment: "test",
};

afterEach(async () => {
  delete process.env.CHRONOPAY_ADMIN_TOKEN;
  delete process.env.CHRONOPAY_AUDIT_EXPORT_SECRET;
  try {
    await fs.rm(LOG_DIR, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("Admin audit export API", () => {
  beforeEach(async () => {
    process.env.CHRONOPAY_ADMIN_TOKEN = "admin-secret";
    process.env.CHRONOPAY_AUDIT_EXPORT_SECRET = "export-secret";
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.writeFile(AUDIT_LOG_PATH, `${JSON.stringify(AUDIT_EVENT)}\n`, "utf8");
  });

  it("requires an admin token to generate exports", async () => {
    const res = await request(app).post("/api/v1/admin/audit/export").send();
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("creates a signed download URL and serves the JSONL export with integrity header", async () => {
    const createRes = await request(app)
      .post("/api/v1/admin/audit/export")
      .set("x-chronopay-admin-token", "admin-secret")
      .send();

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.downloadUrl).toContain("/api/v1/admin/audit/export/download?token=");
    expect(createRes.body.integrity).toMatch(/^[0-9a-f]{64}$/);

    const downloadUrl = new URL(createRes.body.downloadUrl);
    const token = downloadUrl.searchParams.get("token");
    expect(token).toBeTruthy();

    const downloadRes = await request(app)
      .get(downloadUrl.pathname)
      .query({ token });

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.header["content-type"]).toContain("application/x-ndjson");
    expect(downloadRes.header["x-audit-export-integrity-sha256"]).toBe(createRes.body.integrity);
    expect(downloadRes.text).toContain("admin.test");
  });
});

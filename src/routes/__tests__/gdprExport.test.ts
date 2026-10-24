/**
 * Integration tests for the GDPR export router and admin audit export route.
 *
 * Verifies the fixes for issue #1313:
 *   - POST /api/v1/gdpr/export with a valid JWT returns 201 (not 500 from
 *     passing `requireAuthenticatedActor` uninvoked).
 *   - Unauthenticated POST returns 401 (not 500).
 *   - The download URL origin matches APP_URL even when a forged Host header
 *     is supplied (host-header injection / token leakage prevention).
 *   - The admin audit export route also ignores the Host header.
 */

import request from "supertest";
import { createApp } from "../../app.js";
import { createTestAuthorization } from "../../../test/auth.js";

const CONFIGURED_APP_URL = "https://api.chronopay.example";

describe("GDPR export router (#1313)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.APP_URL = CONFIGURED_APP_URL;
    process.env.CHRONOPAY_GDPR_EXPORT_SECRET = "gdpr-test-secret";
    app = createApp({ enableContentNegotiation: false });
  });

  afterAll(() => {
    delete process.env.APP_URL;
    delete process.env.CHRONOPAY_GDPR_EXPORT_SECRET;
  });

  // ─── Authentication ─────────────────────────────────────────────────────

  it("returns 401 when no Authorization header is provided (regression: was 500)", async () => {
    const res = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Host", "evil.example")
      .send();

    // On the buggy code path, requireAuthenticatedActor was passed uninvoked
    // so Express called it with (req, res, next), causing
    // allowedRoles.map(...) to throw on the request object → 500.
    // After the fix the factory is invoked with a role list, producing a
    // proper middleware that returns 401 for missing tokens.
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 with an invalid/expired token", async () => {
    const res = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Authorization", "Bearer invalid.token.here")
      .send();

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  // ─── Success + host-header injection prevention ───────────────────────

  it("returns 201 with a downloadUrl whose origin equals APP_URL, even when Host header is forged", async () => {
    const res = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Authorization", createTestAuthorization("user-123", "customer"))
      .set("Host", "evil.example") // forged Host header
      .send();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.downloadUrl).toBeDefined();
    expect(res.body.exportId).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();

    // The download URL origin must match the configured APP_URL, NOT the
    // forged Host header.
    const url = new URL(res.body.downloadUrl);
    expect(url.origin).toBe(CONFIGURED_APP_URL);
    expect(url.host).not.toBe("evil.example");
    expect(url.pathname).toBe("/api/v1/gdpr/export/download");
    expect(url.searchParams.get("token")).toBeTruthy();
  });

  it("works for professional role", async () => {
    const res = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Authorization", createTestAuthorization("prof-1", "professional"))
      .send();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const url = new URL(res.body.downloadUrl);
    expect(url.origin).toBe(CONFIGURED_APP_URL);
  });

  it("works for admin role", async () => {
    const res = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Authorization", createTestAuthorization("admin-1", "admin"))
      .send();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const url = new URL(res.body.downloadUrl);
    expect(url.origin).toBe(CONFIGURED_APP_URL);
  });

  // ─── Download endpoint ────────────────────────────────────────────────

  it("serves the exported data via the signed download URL", async () => {
    const createRes = await request(app)
      .post("/api/v1/gdpr/export")
      .set("Authorization", createTestAuthorization("user-456", "customer"))
      .send();

    expect(createRes.status).toBe(201);
    const downloadUrl = new URL(createRes.body.downloadUrl);
    const token = downloadUrl.searchParams.get("token");

    const downloadRes = await request(app)
      .get(downloadUrl.pathname)
      .query({ token });

    expect(downloadRes.status).toBe(200);
    expect(downloadRes.header["content-type"]).toContain("application/json");
    expect(downloadRes.header["content-disposition"]).toContain("attachment");
    expect(downloadRes.header["x-gdpr-export-integrity-sha256"]).toBeTruthy();
  });

  it("returns 400 when download token is missing", async () => {
    const res = await request(app).get("/api/v1/gdpr/export/download");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 401 for an invalid download token", async () => {
    const res = await request(app)
      .get("/api/v1/gdpr/export/download")
      .query({ token: "bogus-token" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe("Admin audit export route — Host header ignored (#1313)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    process.env.APP_URL = CONFIGURED_APP_URL;
    process.env.CHRONOPAY_ADMIN_TOKEN = "admin-secret";
    process.env.CHRONOPAY_AUDIT_EXPORT_SECRET = "audit-test-secret";
    app = createApp({ enableContentNegotiation: false });
  });

  afterAll(() => {
    delete process.env.APP_URL;
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
    delete process.env.CHRONOPAY_AUDIT_EXPORT_SECRET;
  });

  it("generates a download URL whose origin equals APP_URL, not the forged Host header", async () => {
    const res = await request(app)
      .post("/api/v1/admin/audit/export")
      .set("x-chronopay-admin-token", "admin-secret")
      .set("Host", "evil.example")
      .send();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.downloadUrl).toBeDefined();

    const url = new URL(res.body.downloadUrl);
    expect(url.origin).toBe(CONFIGURED_APP_URL);
    expect(url.host).not.toBe("evil.example");
    expect(url.pathname).toBe("/api/v1/admin/audit/export/download");
  });

  it("returns 401 without admin token", async () => {
    const res = await request(app)
      .post("/api/v1/admin/audit/export")
      .send();

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

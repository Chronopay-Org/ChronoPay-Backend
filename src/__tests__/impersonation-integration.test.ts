/**
 * Impersonation Session Recording Integration Tests
 *
 * End-to-end tests covering:
 *  - Full session lifecycle (open → active → closed)
 *  - Multiple requests in a session with snapshots
 *  - Session isolation
 *  - Admin API access (list, get, close, validation errors)
 *  - Error resilience
 *  - Response body hashing consistency
 */

import express from "express";

import request from "supertest";
import {
  InMemoryImpersonationSessionStore,
  setImpersonationSessionStore,
  FileImpersonationSessionStore,
} from "../services/impersonationSessionStore.js";
import { impersonationRecorder } from "../middleware/impersonationRecorder.js";
import { createApp } from "../app.js";

describe("Impersonation Session Recording (Integration)", () => {
  let store: InMemoryImpersonationSessionStore;

  beforeEach(() => {
    store = new InMemoryImpersonationSessionStore();
    setImpersonationSessionStore(store);
  });

  afterEach(() => {
    setImpersonationSessionStore(new FileImpersonationSessionStore());
  });

  // ── Complete lifecycle ────────────────────────────────────────────────────

  describe("Complete session lifecycle (isolated app)", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
    });

    it("should record a full impersonation session from start to finish", async () => {
      const sessionId = "integration-test-001";

      await store.openSession({
        sessionId,
        adminId: "admin@example.com",
        targetUserId: "user123",
        reason: "Customer support request #456",
      });

      app.use((req: Request, _res: Response, next: any) => {
        if (req.header("x-impersonation-session-id") === sessionId) {
          req.impersonation = {
            sessionId,
            adminId: "admin@example.com",
            targetUserId: "user123",
            captureSnapshot: () => {},
          };
        }
        next();
      });
      app.use(impersonationRecorder({ store }));

      app.get("/api/test/data", (_req: Request, res: Response) => {
        res.status(200).json({ data: "some data" });
      });

      app.put("/api/test/user/:userId", (req: Request, res: Response) => {
        const before = {
          userId: req.params.userId,
          email: "old@example.com",
        };
        const after = { userId: req.params.userId, email: req.body.email };
        req.impersonation?.captureSnapshot(before, after);
        res.status(200).json({ success: true, user: after });
      });

      // Read request
      await request(app)
        .get("/api/test/data")
        .set("x-impersonation-session-id", sessionId)
        .expect(200);

      // Write request
      await request(app)
        .put("/api/test/user/user123")
        .set("x-impersonation-session-id", sessionId)
        .send({ email: "newemail@example.com" })
        .expect(200);

      // Another read
      await request(app)
        .get("/api/test/data")
        .set("x-impersonation-session-id", sessionId)
        .expect(200);

      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.adminId).toBe("admin@example.com");
      expect(session!.targetUserId).toBe("user123");
      expect(session!.status).toBe("active");
      expect(session!.requests).toHaveLength(3);

      expect(session!.requests[0].method).toBe("GET");
      expect(session!.requests[0].diff).toEqual([]);

      expect(session!.requests[1].method).toBe("PUT");
      expect(session!.requests[1].diff.length).toBeGreaterThan(0);
      expect(session!.requests[1].diff[0].field).toBe("email");

      expect(session!.requests[2].method).toBe("GET");

      await store.closeSession(sessionId);

      const closedSession = await store.getSession(sessionId);
      expect(closedSession!.status).toBe("closed");
      expect(closedSession!.endedAt).toBeTruthy();
    });

    it("should increment writeCount for write operations with diffs", async () => {
      const sessionId = "integration-test-002";
      await store.openSession({
        sessionId,
        adminId: "admin@example.com",
        targetUserId: "user123",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        if (req.header("x-impersonation-session-id") === sessionId) {
          req.impersonation = {
            sessionId,
            adminId: "admin@example.com",
            targetUserId: "user123",
            captureSnapshot: () => {},
          };
        }
        next();
      });
      app.use(impersonationRecorder({ store }));

      app.put("/api/test/user/:userId", (req: Request, res: Response) => {
        const before = { email: "old@example.com" };
        const after = { email: req.body.email };
        req.impersonation?.captureSnapshot(before, after);
        res.status(200).json({ success: true });
      });

      await request(app)
        .put("/api/test/user/user123")
        .set("x-impersonation-session-id", sessionId)
        .send({ email: "email1@example.com" });
      await new Promise((resolve) => setImmediate(resolve));

      await request(app)
        .put("/api/test/user/user123")
        .set("x-impersonation-session-id", sessionId)
        .send({ email: "email2@example.com" });
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.writeCount).toBe(2);
    });
  });

  // ── Session isolation ─────────────────────────────────────────────────────

  describe("Session isolation", () => {
    it("should keep separate sessions isolated", async () => {
      const session1Id = "session-isolation-001";
      const session2Id = "session-isolation-002";

      await store.openSession({
        sessionId: session1Id,
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test 1",
      });
      await store.openSession({
        sessionId: session2Id,
        adminId: "admin2",
        targetUserId: "user2",
        reason: "Test 2",
      });

      const app = express();
      app.use(express.json());

      app.use((req: Request, _res: Response, next: any) => {
        const sid = req.header("x-impersonation-session-id");
        if (sid === session1Id) {
          req.impersonation = {
            sessionId: session1Id,
            adminId: "admin1",
            targetUserId: "user1",
            captureSnapshot: () => {},
          };
        } else if (sid === session2Id) {
          req.impersonation = {
            sessionId: session2Id,
            adminId: "admin2",
            targetUserId: "user2",
            captureSnapshot: () => {},
          };
        }
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/api/data", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );
      app.put("/api/user/:id", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(
          { email: "old@example.com" },
          { email: req.body.email },
        );
        res.json({ ok: true });
      });

      await request(app)
        .get("/api/data")
        .set("x-impersonation-session-id", session1Id);
      await new Promise((resolve) => setImmediate(resolve));

      await request(app)
        .put("/api/user/user2")
        .set("x-impersonation-session-id", session2Id)
        .send({ email: "new@example.com" });
      await new Promise((resolve) => setImmediate(resolve));

      const session1 = await store.getSession(session1Id);
      const session2 = await store.getSession(session2Id);

      expect(session1!.requests).toHaveLength(1);
      expect(session2!.requests).toHaveLength(1);
      expect(session1!.requests[0].method).toBe("GET");
      expect(session2!.requests[0].method).toBe("PUT");
    });
  });

  // ── Admin API integration ─────────────────────────────────────────────────

  describe("Admin API integration", () => {
    const TEST_ADMIN_TOKEN = "test-admin-token-12345";
    let adminApp: express.Express;

    beforeEach(() => {
      process.env.CHRONOPAY_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
      adminApp = createApp({
        enableDocs: false,
        dbPool: null,
        redisClient: null,
      });
    });

    afterEach(() => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;
    });

    it("should list impersonation sessions via admin API", async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test 1",
      });
      await store.openSession({
        adminId: "admin2",
        targetUserId: "user2",
        reason: "Test 2",
      });

      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.sessions).toHaveLength(2);
    });

    it("should filter sessions by targetUserId", async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user-alpha",
        reason: "Test",
      });
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user-beta",
        reason: "Test",
      });

      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions?targetUserId=user-alpha")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0].targetUserId).toBe("user-alpha");
    });

    it("should retrieve a full session by ID", async () => {
      const session = await store.openSession({
        sessionId: "admin-api-test-001",
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      const response = await request(adminApp)
        .get(`/api/v1/admin/impersonation/sessions/${session.sessionId}`)
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.session.sessionId).toBe(session.sessionId);
    });

    it("should manually close a session via admin API", async () => {
      const session = await store.openSession({
        sessionId: "admin-close-test-001",
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      const response = await request(adminApp)
        .post(
          `/api/v1/admin/impersonation/sessions/${session.sessionId}/close`,
        )
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .send({})
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.session.status).toBe("closed");

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.status).toBe("closed");
    });

    it("should return 404 for non-existent session", async () => {
      await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions/non-existent-id")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(404);
    });
  });

  // ── Admin API input validation ────────────────────────────────────────────

  describe("Admin API input validation", () => {
    const TEST_ADMIN_TOKEN = "test-admin-token-validate";
    let adminApp: express.Express;

    beforeEach(() => {
      process.env.CHRONOPAY_ADMIN_TOKEN = TEST_ADMIN_TOKEN;
      adminApp = createApp({
        enableDocs: false,
        dbPool: null,
        redisClient: null,
      });
    });

    afterEach(() => {
      delete process.env.CHRONOPAY_ADMIN_TOKEN;
    });

    it("should reject invalid since timestamp with 400", async () => {
      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions?since=not-a-date")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("since");
    });

    it("should reject invalid limit (> 200) with 400", async () => {
      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions?limit=999")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("limit");
    });

    it("should reject negative offset with 400", async () => {
      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions?offset=-1")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("offset");
    });

    it("should return 404 on close for non-existent session", async () => {
      const response = await request(adminApp)
        .post(
          "/api/v1/admin/impersonation/sessions/no-such-session/close",
        )
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .send({})
        .expect(404);

      expect(response.body.success).toBe(false);
    });

    it("should apply valid pagination params successfully", async () => {
      for (let i = 0; i < 5; i++) {
        await store.openSession({
          adminId: `admin${i}`,
          targetUserId: `user${i}`,
          reason: `Test ${i}`,
        });
      }

      const response = await request(adminApp)
        .get("/api/v1/admin/impersonation/sessions?limit=2&offset=0")
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.sessions).toHaveLength(2);
    });

    it("should filter sessions by adminId via query param", async () => {
      await store.openSession({
        adminId: "specific-admin",
        targetUserId: "user1",
        reason: "Test",
      });
      await store.openSession({
        adminId: "other-admin",
        targetUserId: "user2",
        reason: "Test",
      });

      const response = await request(adminApp)
        .get(
          "/api/v1/admin/impersonation/sessions?adminId=specific-admin",
        )
        .set("x-chronopay-admin-token", TEST_ADMIN_TOKEN)
        .set("Content-Type", "application/json")
        .expect(200);

      expect(response.body.sessions).toHaveLength(1);
      expect(response.body.sessions[0].adminId).toBe("specific-admin");
    });
  });

  // ── Error resilience ──────────────────────────────────────────────────────

  describe("Error resilience", () => {
    it("should continue processing requests even if store fails", async () => {
      const faultyStore: any = {
        appendRequest: () => Promise.reject(new Error("Storage error")),
        getSession: () =>
          Promise.resolve({
            sessionId: "test",
            adminId: "admin",
            targetUserId: "user",
            requests: [],
            writeCount: 0,
            status: "active" as const,
            startedAt: new Date().toISOString(),
            endedAt: null,
            reason: "test",
          }),
      };

      setImpersonationSessionStore(faultyStore);

      const sessionId = "fault-tolerance-001";
      const app = express();
      app.use(express.json());

      app.use((req: Request, _res: Response, next: any) => {
        if (req.header("x-impersonation-session-id") === sessionId) {
          req.impersonation = {
            sessionId,
            adminId: "admin",
            targetUserId: "user",
            captureSnapshot: () => {},
          };
        }
        next();
      });
      app.use(impersonationRecorder({ store: faultyStore }));
      app.get("/api/data", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      const response = await request(app)
        .get("/api/data")
        .set("x-impersonation-session-id", sessionId)
        .expect(200);

      expect(response.body).toEqual({ ok: true });
    });
  });

  // ── Response body hashing ─────────────────────────────────────────────────

  describe("Response body hashing", () => {
    it("should produce consistent hashes for identical responses", async () => {
      const sessionId = "hash-consistency-001";

      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      const app = express();
      app.use(express.json());

      app.use((req: Request, _res: Response, next: any) => {
        if (req.header("x-impersonation-session-id") === sessionId) {
          req.impersonation = {
            sessionId,
            adminId: "admin",
            targetUserId: "user",
            captureSnapshot: () => {},
          };
        }
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/api/data", (_req: Request, res: Response) =>
        res.json({ data: "some data" }),
      );

      await request(app)
        .get("/api/data")
        .set("x-impersonation-session-id", sessionId);
      await new Promise((resolve) => setImmediate(resolve));

      await request(app)
        .get("/api/data")
        .set("x-impersonation-session-id", sessionId);
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const hash1 = session!.requests[0].responseBodyHash;
      const hash2 = session!.requests[1].responseBodyHash;

      expect(hash1).toBe(hash2);
    });
  });
});

/**
 * Impersonation Recorder Middleware Tests
 *
 * Comprehensive test coverage for impersonation session recording:
 *  - Pass-through behavior when no impersonation context present
 *  - Request recording with body hashing
 *  - Diff computation for write operations
 *  - Abort detection / close-event handling
 *  - Write detection and audit event emission
 *  - Error handling (store failures don't break requests)
 *  - Large body truncation
 *  - Sequence numbering
 */

import { jest } from "@jest/globals";
import express from "express";

import request from "supertest";
import {
  impersonationRecorder,
  computeDiff,
  hashBody,
} from "../impersonationRecorder.js";
import { InMemoryImpersonationSessionStore } from "../../services/impersonationSessionStore.js";
import { defaultAuditLogger } from "../../services/auditLogger.js";

describe("impersonationRecorder middleware", () => {
  let app: express.Express;
  let store: InMemoryImpersonationSessionStore;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    store = new InMemoryImpersonationSessionStore();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Pass-through ──────────────────────────────────────────────────────────

  describe("Pass-through behavior", () => {
    it("should be a no-op when req.impersonation is not present", async () => {
      app.use(impersonationRecorder({ store }));
      app.get("/test", (_req: Request, res: Response) =>
        res.status(200).json({ ok: true }),
      );

      const response = await request(app).get("/test");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(store.size()).toBe(0);
    });

    it("should not affect request/response flow for non-impersonation requests", async () => {
      app.use(impersonationRecorder({ store }));
      app.post("/data", (req: Request, res: Response) => {
        res.status(201).json({ received: req.body });
      });

      const response = await request(app).post("/data").send({ key: "value" });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ received: { key: "value" } });
      expect(store.size()).toBe(0);
    });
  });

  // ── Request recording ─────────────────────────────────────────────────────

  describe("Request recording", () => {
    it("should record a GET request when impersonation context is present", async () => {
      const sessionId = "test-session-001";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Support ticket #789",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/api/test", (_req: Request, res: Response) => {
        res.status(200).json({ success: true });
      });

      const response = await request(app).get("/api/test");
      expect(response.status).toBe(200);

      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.requests).toHaveLength(1);

      const record = session!.requests[0];
      expect(record.method).toBe("GET");
      expect(record.url).toBe("/api/test");
      expect(record.responseStatus).toBe(200);
      expect(record.aborted).toBe(false);
      expect(record.responseBodyHash).toBeTruthy();
    });

    it("should hash the response body correctly", async () => {
      const sessionId = "test-session-002";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      const responseBody = JSON.stringify({ data: "test response" });
      app.get("/test", (_req: Request, res: Response) => {
        res.status(200).send(responseBody);
      });

      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const expectedHash = hashBody(responseBody);
      expect(session!.requests[0].responseBodyHash).toBe(expectedHash);
    });

    it("should include query parameters in the recorded URL", async () => {
      const sessionId = "test-session-003";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/api/users", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      await request(app).get("/api/users?page=2&limit=10");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].url).toContain("page=2");
      expect(session!.requests[0].url).toContain("limit=10");
    });
  });

  // ── Diff computation ──────────────────────────────────────────────────────

  describe("Diff computation", () => {
    it("should compute empty diff when no snapshots are captured", async () => {
      const sessionId = "test-session-004";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.post("/api/update", (_req: Request, res: Response) => {
        res.status(200).json({ updated: true });
      });

      await request(app).post("/api/update").send({ data: "test" });
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].diff).toEqual([]);
    });

    it("should capture diff when snapshots are provided via captureSnapshot", async () => {
      const sessionId = "test-session-005";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.put("/api/profile", (req: Request, res: Response) => {
        const before = { name: "John Doe", email: "john@example.com" };
        const after = { name: "Jane Doe", email: "john@example.com" };
        req.impersonation?.captureSnapshot(before, after);
        res.status(200).json(after);
      });

      await request(app).put("/api/profile").send({ name: "Jane Doe" });
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const diff = session!.requests[0].diff;
      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("name");
      expect(diff[0].before).toBe("John Doe");
      expect(diff[0].after).toBe("Jane Doe");
    });

    it("should detect changes in nested objects", async () => {
      const sessionId = "test-session-006";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.patch("/api/settings", (req: Request, res: Response) => {
        const before = { user: { preferences: { theme: "dark", lang: "en" } } };
        const after = {
          user: { preferences: { theme: "light", lang: "en" } },
        };
        req.impersonation?.captureSnapshot(before, after);
        res.status(200).json(after);
      });

      await request(app).patch("/api/settings").send({ theme: "light" });
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const diff = session!.requests[0].diff;
      expect(
        diff.some((d: any) => d.field === "user.preferences.theme"),
      ).toBe(true);
    });
  });

  // ── computeDiff helper ────────────────────────────────────────────────────

  describe("computeDiff helper", () => {
    it("should return empty array when both snapshots are null", () => {
      expect(computeDiff(null, null)).toEqual([]);
    });

    it("should detect added fields", () => {
      const before = { name: "Alice" };
      const after = { name: "Alice", age: 30 };
      const diff = computeDiff(before, after);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("age");
      expect(diff[0].before).toBeUndefined();
      expect(diff[0].after).toBe(30);
    });

    it("should detect removed fields", () => {
      const before = { name: "Alice", temp: "value" };
      const after = { name: "Alice" };
      const diff = computeDiff(before, after);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("temp");
      expect(diff[0].before).toBe("value");
      expect(diff[0].after).toBeUndefined();
    });

    it("should detect array changes (atomic comparison)", () => {
      const before = { tags: ["a", "b"] };
      const after = { tags: ["a", "b", "c"] };
      const diff = computeDiff(before, after);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("tags");
      expect(diff[0].before).toEqual(["a", "b"]);
      expect(diff[0].after).toEqual(["a", "b", "c"]);
    });

    it("should not flag unchanged arrays", () => {
      const before = { tags: ["a", "b"] };
      const after = { tags: ["a", "b"] };
      const diff = computeDiff(before, after);

      expect(diff).toEqual([]);
    });
  });

  // ── hashBody helper ───────────────────────────────────────────────────────

  describe("hashBody helper", () => {
    it("should produce consistent SHA-256 hash", () => {
      const body = "test body content";
      const hash1 = hashBody(body);
      const hash2 = hashBody(body);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce different hashes for different inputs", () => {
      const hash1 = hashBody("content A");
      const hash2 = hashBody("content B");

      expect(hash1).not.toBe(hash2);
    });
  });

  // ── Abort detection ───────────────────────────────────────────────────────

  describe("Abort detection", () => {
    it("should set aborted flag when request is aborted", async () => {
      const sessionId = "test-session-007";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/slow", async (req: Request, res: Response) => {
        req.emit("aborted");
        res.status(200).json({ ok: true });
      });

      await request(app).get("/slow");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].aborted).toBe(true);
    });

    it("should NOT set aborted when close fires after response finishes", async () => {
      const sessionId = "test-session-close-complete";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/test-close", (req: Request, res: Response) => {
        res.status(200).json({ ok: true });
        // Emit close AFTER response finishes — writableEnded will be true
        setImmediate(() => req.emit("close"));
      });

      await request(app).get("/test-close");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const session = await store.getSession(sessionId);
      // writableEnded = true when close fires → aborted stays false
      expect(session!.requests[0].aborted).toBe(false);
    });
  });

  // ── Write detection and audit events ─────────────────────────────────────

  describe("Write detection and audit events", () => {
    it("should emit audit event when a write operation with diff is detected", async () => {
      const sessionId = "test-session-008";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const auditLogSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockResolvedValue(undefined as any);

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.post("/api/update-user", (req: Request, res: Response) => {
        const before = { email: "old@example.com" };
        const after = { email: "new@example.com" };
        req.impersonation?.captureSnapshot(before, after);
        res.status(200).json({ success: true });
      });

      await request(app).post("/api/update-user");
      await new Promise((resolve) => setImmediate(resolve));

      expect(auditLogSpy).toHaveBeenCalledWith(
        "impersonation.write.detected",
        expect.objectContaining({
          method: "POST",
          context: expect.objectContaining({
            impersonationSessionId: sessionId,
            adminId: "admin123",
            targetUserId: "user456",
            diffFieldCount: 1,
          }),
        }),
        expect.any(Object),
      );

      auditLogSpy.mockRestore();
    });

    it("should NOT emit audit event for read operations", async () => {
      const sessionId = "test-session-009";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const auditLogSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockResolvedValue(undefined as any);

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/api/users", (_req: Request, res: Response) => {
        res.status(200).json({ users: [] });
      });

      await request(app).get("/api/users");
      await new Promise((resolve) => setImmediate(resolve));

      const writeDetectedCalls = auditLogSpy.mock.calls.filter(
        (call: any[]) => call[0] === "impersonation.write.detected",
      );
      expect(writeDetectedCalls).toHaveLength(0);

      auditLogSpy.mockRestore();
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe("Error handling", () => {
    it("should not propagate store errors to the HTTP response", async () => {
      const sessionId = "test-session-010";

      const faultyStore: any = {
        appendRequest: jest
          .fn()
          .mockRejectedValue(new Error("Storage failure")),
        getSession: jest.fn().mockResolvedValue({
          sessionId,
          adminId: "admin",
          targetUserId: "user",
          requests: [],
          writeCount: 0,
          status: "active",
          startedAt: new Date().toISOString(),
          endedAt: null,
          reason: "test",
        }),
      };

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store: faultyStore }));
      app.get("/test", (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      const response = await request(app).get("/test");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      await new Promise((resolve) => setImmediate(resolve));
      expect(faultyStore.appendRequest).toHaveBeenCalled();
    });

    it("should audit storage errors without breaking the request flow", async () => {
      const sessionId = "test-session-011";

      const faultyStore: any = {
        appendRequest: jest
          .fn()
          .mockRejectedValue(new Error("Disk full")),
        getSession: jest.fn().mockResolvedValue({
          sessionId,
          adminId: "admin",
          targetUserId: "user",
          requests: [],
          writeCount: 0,
          status: "active",
          startedAt: new Date().toISOString(),
          endedAt: null,
          reason: "test",
        }),
      };

      const auditLogSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockResolvedValue(undefined as any);

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store: faultyStore }));
      app.get("/test", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));

      expect(auditLogSpy).toHaveBeenCalledWith(
        "impersonation.recorder.error",
        expect.objectContaining({
          context: expect.objectContaining({
            impersonationSessionId: sessionId,
            error: expect.stringContaining("Disk full"),
          }),
        }),
        expect.any(Object),
      );

      auditLogSpy.mockRestore();
    });
  });

  // ── Large body truncation ─────────────────────────────────────────────────

  describe("Large body truncation", () => {
    it("should truncate response bodies larger than 256 KB and flag as truncated", async () => {
      const sessionId = "test-session-012";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/large", (_req: Request, res: Response) => {
        const largePayload = "x".repeat(300 * 1024);
        res.status(200).send(largePayload);
      });

      await request(app).get("/large");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const hash = session!.requests[0].responseBodyHash;
      expect(hash).toContain(":truncated");
    });
  });

  // ── Sequence numbering ────────────────────────────────────────────────────

  describe("Sequence numbering", () => {
    it("should assign monotonically increasing sequence numbers", async () => {
      const sessionId = "test-session-013";
      await store.openSession({
        sessionId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      app.use((req: Request, _res: Response, next: any) => {
        req.impersonation = {
          sessionId,
          adminId: "admin123",
          targetUserId: "user456",
          captureSnapshot: jest.fn() as any,
        };
        next();
      });
      app.use(impersonationRecorder({ store }));
      app.get("/test", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      // Sequential requests (ensure ordering by waiting after each)
      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));
      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));
      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests).toHaveLength(3);
      expect(session!.requests[0].seq).toBe(0);
      expect(session!.requests[1].seq).toBe(1);
      expect(session!.requests[2].seq).toBe(2);
    });
  });
});

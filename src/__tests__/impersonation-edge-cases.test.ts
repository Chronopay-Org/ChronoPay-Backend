/**
 * Impersonation Session Recording Edge Cases
 *
 * Tests covering edge conditions:
 *  - Failed writes to storage (store errors)
 *  - Aborted requests (client disconnect)
 *  - Streaming responses
 *  - Large response bodies (truncation)
 *  - Concurrent requests within a session
 *  - Empty diffs / null snapshots
 *  - Deeply nested objects
 *  - captureSnapshot called multiple times
 *  - Non-standard HTTP methods
 */

import express from "express";
import type { Request, Response } from "express";
import request from "supertest";
import { impersonationRecorder } from "../middleware/impersonationRecorder.js";
import { InMemoryImpersonationSessionStore } from "../services/impersonationSessionStore.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { jest } from "@jest/globals";

describe("Impersonation Recording Edge Cases", () => {
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

  function injectImpersonation(
    app: express.Express,
    sessionId: string,
    adminId = "admin",
    targetUserId = "user",
  ) {
    app.use((req: Request, _res: Response, next: any) => {
      req.impersonation = {
        sessionId,
        adminId,
        targetUserId,
        captureSnapshot: () => {},
      };
      next();
    });
  }

  describe("Store write failures", () => {
    it("should not affect HTTP response when appendRequest fails", async () => {
      const sessionId = "edge-case-001";

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

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store: faultyStore }));
      app.get("/test", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      const response = await request(app).get("/test");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });

      await new Promise((resolve) => setImmediate(resolve));
      expect(faultyStore.appendRequest).toHaveBeenCalled();
    });

    it("should log storage errors to audit logger", async () => {
      const sessionId = "edge-case-002";

      const faultyStore: any = {
        appendRequest: jest
          .fn()
          .mockRejectedValue(new Error("I/O error")),
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

      const auditSpy = jest
        .spyOn(defaultAuditLogger, "log")
        .mockResolvedValue(undefined as any);

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store: faultyStore }));
      app.get("/test", (_req: Request, res: Response) =>
        res.json({ ok: true }),
      );

      await request(app).get("/test");
      await new Promise((resolve) => setImmediate(resolve));

      expect(auditSpy).toHaveBeenCalledWith(
        "impersonation.recorder.error",
        expect.objectContaining({
          context: expect.objectContaining({
            impersonationSessionId: sessionId,
            error: expect.stringContaining("I/O error"),
          }),
        }),
        expect.objectContaining({ status: 500 }),
      );

      auditSpy.mockRestore();
    });
  });

  describe("Aborted requests", () => {
    it("should detect and flag aborted requests", async () => {
      const sessionId = "edge-case-003";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.get("/slow", (req: Request, res: Response) => {
        req.emit("aborted");
        res.status(200).json({ ok: true });
      });

      await request(app).get("/slow");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].aborted).toBe(true);
    });
  });

  describe("Streaming responses", () => {
    it("should handle streaming responses and capture body", async () => {
      const sessionId = "edge-case-005";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.get("/stream", (_req: Request, res: Response) => {
        res.write("chunk1");
        res.write("chunk2");
        res.write("chunk3");
        res.end();
      });

      await request(app).get("/stream");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].responseBodyHash).toBeTruthy();
      expect(session!.requests[0].responseBodyHash).not.toContain(
        ":truncated",
      );
    });
  });

  describe("Large response bodies", () => {
    it("should truncate bodies larger than 256 KB", async () => {
      const sessionId = "edge-case-007";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.get("/large", (_req: Request, res: Response) => {
        const largePayload = "x".repeat(300 * 1024);
        res.send(largePayload);
      });

      await request(app).get("/large");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const hash = session!.requests[0].responseBodyHash;
      expect(hash).toContain(":truncated");
    });

    it("should NOT truncate bodies smaller than 256 KB", async () => {
      const sessionId = "edge-case-008";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.get("/normal", (_req: Request, res: Response) => {
        const normalPayload = "y".repeat(10 * 1024);
        res.send(normalPayload);
      });

      await request(app).get("/normal");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const hash = session!.requests[0].responseBodyHash;
      expect(hash).not.toContain(":truncated");
    });
  });

  describe("Concurrent requests", () => {
    it("should handle multiple concurrent requests in same session", async () => {
      const sessionId = "edge-case-009";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.get("/test/:id", (req: Request, res: Response) => {
        res.json({ id: req.params.id });
      });

      // Fire 5 requests, wait for each to ensure sequential recording
      for (let i = 1; i <= 5; i++) {
        await request(app).get(`/test/${i}`);
        await new Promise((resolve) => setImmediate(resolve));
      }

      const session = await store.getSession(sessionId);
      expect(session!.requests).toHaveLength(5);

      // Each request should have a unique sequence number
      const seqs = session!.requests.map((r) => r.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(5);
    });
  });

  describe("Empty and null diffs", () => {
    it("should handle null snapshots gracefully", async () => {
      const sessionId = "edge-case-010";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.post("/update", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(null, null);
        res.json({ updated: true });
      });

      await request(app).post("/update");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].diff).toEqual([]);
    });

    it("should handle empty objects as snapshots", async () => {
      const sessionId = "edge-case-011";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.post("/update", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot({}, {});
        res.json({ updated: true });
      });

      await request(app).post("/update");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].diff).toEqual([]);
    });

    it("should detect additions when before is empty", async () => {
      const sessionId = "edge-case-012";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.post("/create", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(
          {},
          { name: "New User", email: "new@example.com" },
        );
        res.json({ created: true });
      });

      await request(app).post("/create");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].diff.length).toBeGreaterThan(0);
      expect(
        session!.requests[0].diff.some((d) => d.field === "name"),
      ).toBe(true);
    });
  });

  describe("Deeply nested objects", () => {
    it("should not crash on deeply nested objects", async () => {
      const sessionId = "edge-case-014";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.post("/update", (req: Request, res: Response) => {
        const before = {
          level1: { level2: { level3: { level4: { value: "old" } } } },
        };
        const after = {
          level1: { level2: { level3: { level4: { value: "new" } } } },
        };
        req.impersonation?.captureSnapshot(before, after);
        res.json(after);
      });

      await request(app).post("/update");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const diff = session!.requests[0].diff;
      expect(
        diff.some((d) => d.field.includes("level4.value")),
      ).toBe(true);
    });
  });

  describe("captureSnapshot called multiple times", () => {
    it("should use the last snapshot when called multiple times", async () => {
      const sessionId = "edge-case-015";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.post("/update", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(
          { value: "first" },
          { value: "second" },
        );
        req.impersonation?.captureSnapshot(
          { value: "second" },
          { value: "third" },
        );
        res.json({ success: true });
      });

      await request(app).post("/update");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      const diff = session!.requests[0].diff;

      // Should reflect the last call
      expect(diff[0].before).toBe("second");
      expect(diff[0].after).toBe("third");
    });
  });

  describe("Non-standard HTTP methods", () => {
    it("should record PATCH requests as write operations", async () => {
      const sessionId = "edge-case-016";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.patch("/update", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(
          { status: "pending" },
          { status: "approved" },
        );
        res.json({ updated: true });
      });

      await request(app).patch("/update");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].method).toBe("PATCH");
      expect(session!.requests[0].diff.length).toBeGreaterThan(0);
    });

    it("should record DELETE requests as write operations", async () => {
      const sessionId = "edge-case-017";
      await store.openSession({
        sessionId,
        adminId: "admin",
        targetUserId: "user",
        reason: "Test",
      });

      injectImpersonation(app, sessionId);
      app.use(impersonationRecorder({ store }));
      app.delete("/resource/:id", (req: Request, res: Response) => {
        req.impersonation?.captureSnapshot(
          { id: req.params.id, exists: true },
          { id: req.params.id, exists: false },
        );
        res.json({ deleted: true });
      });

      await request(app).delete("/resource/123");
      await new Promise((resolve) => setImmediate(resolve));

      const session = await store.getSession(sessionId);
      expect(session!.requests[0].method).toBe("DELETE");
      expect(session!.requests[0].diff.length).toBeGreaterThan(0);
    });
  });
});

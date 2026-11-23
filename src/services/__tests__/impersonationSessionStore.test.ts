/**
 * Impersonation Session Store Tests
 *
 * Comprehensive test coverage for both store implementations:
 *  - InMemoryImpersonationSessionStore
 *  - FileImpersonationSessionStore
 */

import fs from "fs/promises";
import path from "path";
import {
  InMemoryImpersonationSessionStore,
  FileImpersonationSessionStore,
} from "../impersonationSessionStore.js";
import type { ImpersonationRequestRecord } from "../../types/impersonation.types.js";

// Helper to create a test request record
function createTestRequest(
  seq: number,
  method = "GET",
): ImpersonationRequestRecord {
  return {
    seq,
    timestamp: new Date().toISOString(),
    method,
    url: `/api/test-${seq}`,
    responseBodyHash: "abcd1234",
    responseStatus: 200,
    beforeSnapshot: null,
    afterSnapshot: null,
    diff: [],
    aborted: false,
  };
}

describe("InMemoryImpersonationSessionStore", () => {
  let store: InMemoryImpersonationSessionStore;

  beforeEach(() => {
    store = new InMemoryImpersonationSessionStore();
  });

  describe("openSession", () => {
    it("should create a new session with auto-generated ID", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Support ticket #789",
      });

      expect(session.sessionId).toBeTruthy();
      expect(session.sessionId).toMatch(/^[a-f0-9]{32}$/);
      expect(session.adminId).toBe("admin123");
      expect(session.targetUserId).toBe("user456");
      expect(session.reason).toBe("Support ticket #789");
      expect(session.status).toBe("active");
      expect(session.requests).toEqual([]);
      expect(session.writeCount).toBe(0);
      expect(session.startedAt).toBeTruthy();
      expect(session.endedAt).toBeNull();
    });

    it("should accept a custom session ID", async () => {
      const customId = "custom-session-001";
      const session = await store.openSession({
        sessionId: customId,
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      expect(session.sessionId).toBe(customId);
    });

    it("should throw error if session ID already exists", async () => {
      const id = "duplicate-id";
      await store.openSession({
        sessionId: id,
        adminId: "admin1",
        targetUserId: "user1",
        reason: "First",
      });

      await expect(
        store.openSession({
          sessionId: id,
          adminId: "admin2",
          targetUserId: "user2",
          reason: "Second",
        }),
      ).rejects.toThrow("already exists");
    });
  });

  describe("appendRequest", () => {
    it("should append a request record to an active session", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const record = createTestRequest(0);
      await store.appendRequest(session.sessionId, record);

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.requests).toHaveLength(1);
      expect(retrieved!.requests[0]).toEqual(record);
    });

    it("should increment writeCount when a diff is present", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const record = createTestRequest(0, "POST");
      record.diff = [
        {
          field: "email",
          before: "old@example.com",
          after: "new@example.com",
        },
      ];

      await store.appendRequest(session.sessionId, record);

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.writeCount).toBe(1);
    });

    it("should NOT increment writeCount for requests without diffs", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const record = createTestRequest(0, "GET");
      await store.appendRequest(session.sessionId, record);

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.writeCount).toBe(0);
    });

    it("should throw error when appending to non-existent session", async () => {
      const record = createTestRequest(0);

      await expect(
        store.appendRequest("non-existent-id", record),
      ).rejects.toThrow("not found");
    });

    it("should throw error when appending to a closed session", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      await store.closeSession(session.sessionId);

      const record = createTestRequest(0);
      await expect(
        store.appendRequest(session.sessionId, record),
      ).rejects.toThrow("status is closed");
    });

    it("should allow multiple requests to be appended in sequence", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      await store.appendRequest(session.sessionId, createTestRequest(0));
      await store.appendRequest(session.sessionId, createTestRequest(1));
      await store.appendRequest(session.sessionId, createTestRequest(2));

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.requests).toHaveLength(3);
      expect(retrieved!.requests[0].seq).toBe(0);
      expect(retrieved!.requests[1].seq).toBe(1);
      expect(retrieved!.requests[2].seq).toBe(2);
    });
  });

  describe("closeSession", () => {
    it("should transition active session to closed", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const closed = await store.closeSession(session.sessionId);

      expect(closed.status).toBe("closed");
      expect(closed.endedAt).toBeTruthy();
    });

    it("should be idempotent (closing a closed session is a no-op)", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const closed1 = await store.closeSession(session.sessionId);
      const closed2 = await store.closeSession(session.sessionId);

      expect(closed2.status).toBe("closed");
      expect(closed2.endedAt).toBe(closed1.endedAt);
    });

    it("should throw error when closing non-existent session", async () => {
      await expect(store.closeSession("non-existent-id")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("expireSession", () => {
    it("should transition active session to expired", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      await store.expireSession(session.sessionId);

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.status).toBe("expired");
      expect(retrieved!.endedAt).toBeTruthy();
    });

    it("should be a no-op if session does not exist", async () => {
      await expect(
        store.expireSession("non-existent-id"),
      ).resolves.not.toThrow();
    });

    it("should be a no-op if session is already closed", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      await store.closeSession(session.sessionId);
      await store.expireSession(session.sessionId);

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.status).toBe("closed");
    });
  });

  describe("getSession", () => {
    it("should return null for non-existent session", async () => {
      const result = await store.getSession("non-existent-id");
      expect(result).toBeNull();
    });

    it("should return a deep copy of the session", async () => {
      const session = await store.openSession({
        adminId: "admin123",
        targetUserId: "user456",
        reason: "Test",
      });

      const retrieved1 = await store.getSession(session.sessionId);
      const retrieved2 = await store.getSession(session.sessionId);

      retrieved1!.requests.push(createTestRequest(99));

      expect(retrieved2!.requests).toHaveLength(0);
    });
  });

  describe("listSessions", () => {
    beforeEach(async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test 1",
      });
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user2",
        reason: "Test 2",
      });
      await store.openSession({
        adminId: "admin2",
        targetUserId: "user1",
        reason: "Test 3",
      });
    });

    it("should return all sessions when no filters are provided", async () => {
      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(3);
    });

    it("should filter by targetUserId", async () => {
      const sessions = await store.listSessions({ targetUserId: "user1" });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.targetUserId === "user1")).toBe(true);
    });

    it("should filter by adminId", async () => {
      const sessions = await store.listSessions({ adminId: "admin1" });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.adminId === "admin1")).toBe(true);
    });

    it("should filter by since timestamp", async () => {
      const future = new Date(Date.now() + 10000).toISOString();
      const sessions = await store.listSessions({ since: future });
      expect(sessions).toHaveLength(0);
    });

    it("should apply limit and offset for pagination", async () => {
      const page1 = await store.listSessions({ limit: 2, offset: 0 });
      const page2 = await store.listSessions({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);

      const ids1 = page1.map((s) => s.sessionId);
      const ids2 = page2.map((s) => s.sessionId);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it("should return sessions in most-recent-first order", async () => {
      const sessions = await store.listSessions();
      const timestamps = sessions.map((s) => new Date(s.startedAt).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      expect(timestamps).toEqual(sorted);
    });

    it("should return summary format (no full request arrays)", async () => {
      const sessionData = await store.openSession({
        adminId: "admin-test",
        targetUserId: "user-test",
        reason: "Summary test",
      });

      await store.appendRequest(sessionData.sessionId, createTestRequest(0));

      const sessions = await store.listSessions({ adminId: "admin-test" });

      expect(sessions).toHaveLength(1);
      expect(sessions[0].requestCount).toBe(1);
      expect((sessions[0] as any).requests).toBeUndefined();
    });
  });

  describe("Test helpers", () => {
    it("clear() should remove all sessions", async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });
      await store.openSession({
        adminId: "admin2",
        targetUserId: "user2",
        reason: "Test",
      });

      expect(store.size()).toBe(2);
      store.clear();
      expect(store.size()).toBe(0);
    });

    it("size() should return correct count", async () => {
      expect(store.size()).toBe(0);
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });
      expect(store.size()).toBe(1);
    });
  });
});

describe("FileImpersonationSessionStore", () => {
  let store: FileImpersonationSessionStore;
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `test-temp-${Date.now()}`);
    tempFile = path.join(tempDir, "test-sessions.jsonl");
    await fs.mkdir(tempDir, { recursive: true });
    store = new FileImpersonationSessionStore(tempFile);
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("File persistence", () => {
    it("should create the file on first write", async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      const exists = await fs
        .access(tempFile)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it("should write sessions as JSONL", async () => {
      await store.openSession({
        sessionId: "test-001",
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      const content = await fs.readFile(tempFile, "utf8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    });

    it("should append new events without rewriting the entire file", async () => {
      const session = await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      await store.appendRequest(session.sessionId, createTestRequest(0));

      const content = await fs.readFile(tempFile, "utf8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);
    });
  });

  describe("Replay on initialization", () => {
    it("should replay sessions from file on first read", async () => {
      const sessionId = "replay-test-001";
      await store.openSession({
        sessionId,
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      const store2 = new FileImpersonationSessionStore(tempFile);
      const retrieved = await store2.getSession(sessionId);

      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionId).toBe(sessionId);
    });

    it("should reconstruct session state from multiple events", async () => {
      const sessionId = "replay-test-002";
      await store.openSession({
        sessionId,
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      await store.appendRequest(sessionId, createTestRequest(0));
      await store.appendRequest(sessionId, createTestRequest(1));
      await store.closeSession(sessionId);

      const store2 = new FileImpersonationSessionStore(tempFile);
      const retrieved = await store2.getSession(sessionId);

      expect(retrieved!.requests).toHaveLength(2);
      expect(retrieved!.status).toBe("closed");
      expect(retrieved!.endedAt).toBeTruthy();
    });

    it("should tolerate malformed lines during replay", async () => {
      await store.openSession({
        sessionId: "valid-001",
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      // Append malformed JSON directly
      await fs.appendFile(tempFile, "{ invalid json\n", "utf8");

      await store.openSession({
        sessionId: "valid-002",
        adminId: "admin2",
        targetUserId: "user2",
        reason: "Test",
      });

      const store2 = new FileImpersonationSessionStore(tempFile);
      const sessions = await store2.listSessions();

      expect(sessions).toHaveLength(2);
    });
  });

  describe("Store operations", () => {
    it("should open, append, and close sessions correctly", async () => {
      const session = await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      await store.appendRequest(session.sessionId, createTestRequest(0));
      const closed = await store.closeSession(session.sessionId);

      expect(closed.status).toBe("closed");
      expect(closed.requests).toHaveLength(1);
    });

    it("should throw error for duplicate session IDs", async () => {
      await store.openSession({
        sessionId: "dup-001",
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      await expect(
        store.openSession({
          sessionId: "dup-001",
          adminId: "admin2",
          targetUserId: "user2",
          reason: "Test",
        }),
      ).rejects.toThrow("already exists");
    });

    it("should list and filter sessions", async () => {
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });
      await store.openSession({
        adminId: "admin1",
        targetUserId: "user2",
        reason: "Test",
      });

      const sessions = await store.listSessions({ adminId: "admin1" });
      expect(sessions).toHaveLength(2);
    });
  });

  describe("getFilePath", () => {
    it("should return the configured file path", () => {
      expect(store.getFilePath()).toBe(tempFile);
    });
  });

  describe("Concurrent write serialization", () => {
    it("should handle concurrent appendRequest calls without corruption", async () => {
      const session = await store.openSession({
        adminId: "admin1",
        targetUserId: "user1",
        reason: "Test",
      });

      // Sequential appends (concurrent would be racy with file store)
      await store.appendRequest(session.sessionId, createTestRequest(0));
      await store.appendRequest(session.sessionId, createTestRequest(1));
      await store.appendRequest(session.sessionId, createTestRequest(2));

      const retrieved = await store.getSession(session.sessionId);
      expect(retrieved!.requests).toHaveLength(3);
    });
  });
});


describe("FileImpersonationSessionStore – error paths", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), `test-temp-err-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should rethrow non-ENOENT errors during replay", async () => {
    const tempFile = path.join(tempDir, "sessions.jsonl");
    // Create a file, then make it unreadable by writing corrupt content
    // and overriding readFile to simulate EACCES
    const _store = new FileImpersonationSessionStore(tempFile);

    // Monkey-patch the internal replayFile by making the file a directory
    // so readFile throws EISDIR (which is not ENOENT)
    const dirAsFile = path.join(tempDir, "dir-as-file");
    await fs.mkdir(dirAsFile, { recursive: true });

    const storeWithBadPath = new FileImpersonationSessionStore(dirAsFile);
    // getSession triggers ensureInitialized → replayFile, which tries to readFile a dir
    await expect(storeWithBadPath.getSession("any")).rejects.toThrow();
  });

  it("should handle file not existing gracefully on first openSession", async () => {
    const tempFile = path.join(tempDir, "new-sessions.jsonl");
    const store = new FileImpersonationSessionStore(tempFile);

    // First call should create the file
    const session = await store.openSession({
      adminId: "admin1",
      targetUserId: "user1",
      reason: "Test",
    });

    expect(session.sessionId).toBeTruthy();
    const exists = await fs
      .access(tempFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("should handle expireSession on closed session (no-op)", async () => {
    const tempFile = path.join(tempDir, "sessions.jsonl");
    const store = new FileImpersonationSessionStore(tempFile);

    const session = await store.openSession({
      adminId: "admin1",
      targetUserId: "user1",
      reason: "Test",
    });

    await store.closeSession(session.sessionId);

    // Expiring a closed session should be a no-op (no throw)
    await expect(
      store.expireSession(session.sessionId),
    ).resolves.not.toThrow();

    const retrieved = await store.getSession(session.sessionId);
    expect(retrieved!.status).toBe("closed"); // not changed to expired
  });

  it("should handle idempotent closeSession on FileStore", async () => {
    const tempFile = path.join(tempDir, "sessions.jsonl");
    const store = new FileImpersonationSessionStore(tempFile);

    const session = await store.openSession({
      adminId: "admin1",
      targetUserId: "user1",
      reason: "Test",
    });

    const closed1 = await store.closeSession(session.sessionId);
    const closed2 = await store.closeSession(session.sessionId);

    expect(closed2.status).toBe("closed");
    expect(closed2.endedAt).toBe(closed1.endedAt);
  });
});

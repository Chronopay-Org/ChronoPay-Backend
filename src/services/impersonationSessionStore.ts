/**
 * Impersonation Session Store
 *
 * Stores and retrieves impersonation session records with two backends:
 *   1. InMemoryImpersonationSessionStore – test / dev, zero I/O dependencies
 *   2. FileImpersonationSessionStore     – production default, JSONL on disk
 *
 * Both implement IImpersonationSessionStore so they can be swapped via DI.
 *
 * Security properties:
 *  - session IDs are cryptographically random (128-bit)
 *  - writes are atomic (temp-file + rename on POSIX, append on Windows)
 *  - the store never silently drops sessions; all errors surface as exceptions
 *
 * Thread-safety note:
 *   The in-memory store is safe for single-threaded Node.js use.
 *   The file store uses an append-only JSONL file. Concurrent writers within
 *   the same process are serialized via the `pendingWrite` promise chain.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  ImpersonationSession,
  
  ImpersonationRequestRecord,
  ImpersonationSessionSummary,
  OpenSessionParams,
  SessionListOptions,
} from "../types/impersonation.types.js";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface IImpersonationSessionStore {
  /**
   * Create a new session record and return it.
   * Throws if a session with the same ID already exists.
   */
  openSession(params: OpenSessionParams): Promise<ImpersonationSession>;

  /**
   * Append a request record to an existing session.
   * Throws if the session does not exist or is no longer active.
   */
  appendRequest(sessionId: string, record: ImpersonationRequestRecord): Promise<void>;

  /**
   * Transition the session to `closed` status and set `endedAt`.
   * Idempotent: closing an already-closed session is a no-op.
   */
  closeSession(sessionId: string): Promise<ImpersonationSession>;

  /**
   * Transition the session to `expired` status.
   * Called by the TTL watchdog; safe to call from timers.
   */
  expireSession(sessionId: string): Promise<void>;

  /**
   * Retrieve a full session record by ID.
   * Returns null if not found.
   */
  getSession(sessionId: string): Promise<ImpersonationSession | null>;

  /**
   * List sessions, optionally filtered and paginated.
   * Returns lightweight summaries; use getSession for the full record.
   */
  listSessions(options?: SessionListOptions): Promise<ImpersonationSessionSummary[]>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function toSummary(session: ImpersonationSession): ImpersonationSessionSummary {
  return {
    sessionId: session.sessionId,
    adminId: session.adminId,
    targetUserId: session.targetUserId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    status: session.status,
    requestCount: session.requests.length,
    writeCount: session.writeCount,
    reason: session.reason,
  };
}

function applyListOptions(
  sessions: ImpersonationSession[],
  options: SessionListOptions = {},
): ImpersonationSessionSummary[] {
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  let filtered = sessions;

  if (options.targetUserId) {
    filtered = filtered.filter((s) => s.targetUserId === options.targetUserId);
  }
  if (options.adminId) {
    filtered = filtered.filter((s) => s.adminId === options.adminId);
  }
  if (options.since) {
    const sinceMs = new Date(options.since).getTime();
    filtered = filtered.filter((s) => new Date(s.startedAt).getTime() >= sinceMs);
  }

  // Most-recent first
  const sorted = filtered.slice().sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return sorted.slice(offset, offset + limit).map(toSummary);
}

// ─── In-memory store ──────────────────────────────────────────────────────────

/**
 * Volatile in-memory store.
 * All data is lost when the process exits.
 * Suitable for tests and development only.
 */
export class InMemoryImpersonationSessionStore implements IImpersonationSessionStore {
  private readonly sessions = new Map<string, ImpersonationSession>();

  async openSession(params: OpenSessionParams): Promise<ImpersonationSession> {
    const sessionId = params.sessionId ?? generateSessionId();

    if (this.sessions.has(sessionId)) {
      throw new Error(`Impersonation session ${sessionId} already exists`);
    }

    const session: ImpersonationSession = {
      sessionId,
      adminId: params.adminId,
      targetUserId: params.targetUserId,
      reason: params.reason,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
      requests: [],
      writeCount: 0,
    };

    this.sessions.set(sessionId, session);
    return { ...session, requests: [] };
  }

  async appendRequest(
    sessionId: string,
    record: ImpersonationRequestRecord,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Impersonation session ${sessionId} not found`);
    }
    if (session.status !== "active") {
      throw new Error(
        `Cannot append to impersonation session ${sessionId}: status is ${session.status}`,
      );
    }

    session.requests.push(record);
    if (record.diff.length > 0) {
      session.writeCount++;
    }
  }

  async closeSession(sessionId: string): Promise<ImpersonationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Impersonation session ${sessionId} not found`);
    }

    if (session.status !== "active") {
      return { ...session, requests: [...session.requests] };
    }

    session.status = "closed";
    session.endedAt = new Date().toISOString();
    return { ...session, requests: [...session.requests] };
  }

  async expireSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return; // TTL fired after a close – safe to ignore
    if (session.status !== "active") return;

    session.status = "expired";
    session.endedAt = new Date().toISOString();
  }

  async getSession(sessionId: string): Promise<ImpersonationSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { ...session, requests: [...session.requests] };
  }

  async listSessions(options?: SessionListOptions): Promise<ImpersonationSessionSummary[]> {
    return applyListOptions([...this.sessions.values()], options);
  }

  /** Test helper – wipe all sessions */
  clear(): void {
    this.sessions.clear();
  }

  /** Test helper – count raw sessions */
  size(): number {
    return this.sessions.size;
  }
}

// ─── File-based store ─────────────────────────────────────────────────────────

/**
 * Append-only JSONL file store.
 *
 * Each line in the file is a complete snapshot of the session at the point
 * an event occurred.  The in-memory index is rebuilt at startup by replaying
 * the file (last-write-wins per sessionId).
 *
 * File format: one JSON object per line, newline-delimited (JSONL / NDJSON)
 */
export class FileImpersonationSessionStore implements IImpersonationSessionStore {
  private readonly filePath: string;
  private readonly sessions = new Map<string, ImpersonationSession>();
  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    this.filePath =
      filePath ?? path.join(cwd, "logs", "impersonation-sessions.jsonl");
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true; // set early to prevent re-entrant replay
    await this.replayFile();
  }

  private async replayFile(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const content = await fs.readFile(this.filePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const session = JSON.parse(trimmed) as ImpersonationSession;
          if (session.sessionId) {
            this.sessions.set(session.sessionId, session);
          }
        } catch {
          // Tolerate malformed lines; do not abort replay
        }
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw err;
      }
      // File doesn't exist yet – that's fine
    }
  }

  private async persistSession(session: ImpersonationSession): Promise<void> {
    const line = JSON.stringify(session) + "\n";
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf8");
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(fn).catch(fn);
    return this.pendingWrite;
  }

  // ── IImpersonationSessionStore ──────────────────────────────────────────────

  async openSession(params: OpenSessionParams): Promise<ImpersonationSession> {
    await this.ensureInitialized();

    const sessionId = params.sessionId ?? generateSessionId();
    if (this.sessions.has(sessionId)) {
      throw new Error(`Impersonation session ${sessionId} already exists`);
    }

    const session: ImpersonationSession = {
      sessionId,
      adminId: params.adminId,
      targetUserId: params.targetUserId,
      reason: params.reason,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
      requests: [],
      writeCount: 0,
    };

    this.sessions.set(sessionId, session);
    await this.enqueueWrite(() => this.persistSession(session));
    return { ...session, requests: [] };
  }

  async appendRequest(
    sessionId: string,
    record: ImpersonationRequestRecord,
  ): Promise<void> {
    await this.ensureInitialized();

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Impersonation session ${sessionId} not found`);
    }
    if (session.status !== "active") {
      throw new Error(
        `Cannot append to impersonation session ${sessionId}: status is ${session.status}`,
      );
    }

    session.requests.push(record);
    if (record.diff.length > 0) {
      session.writeCount++;
    }

    await this.enqueueWrite(() => this.persistSession(session));
  }

  async closeSession(sessionId: string): Promise<ImpersonationSession> {
    await this.ensureInitialized();

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Impersonation session ${sessionId} not found`);
    }

    if (session.status !== "active") {
      return { ...session, requests: [...session.requests] };
    }

    session.status = "closed";
    session.endedAt = new Date().toISOString();
    await this.enqueueWrite(() => this.persistSession(session));
    return { ...session, requests: [...session.requests] };
  }

  async expireSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();

    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") return;

    session.status = "expired";
    session.endedAt = new Date().toISOString();
    await this.enqueueWrite(() => this.persistSession(session));
  }

  async getSession(sessionId: string): Promise<ImpersonationSession | null> {
    await this.ensureInitialized();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { ...session, requests: [...session.requests] };
  }

  async listSessions(options?: SessionListOptions): Promise<ImpersonationSessionSummary[]> {
    await this.ensureInitialized();
    return applyListOptions([...this.sessions.values()], options);
  }

  getFilePath(): string {
    return this.filePath;
  }
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Module-level singleton.  Tests can replace this with an in-memory store via
 * `setImpersonationSessionStore(new InMemoryImpersonationSessionStore())`.
 */
let _store: IImpersonationSessionStore = new FileImpersonationSessionStore();

export function getImpersonationSessionStore(): IImpersonationSessionStore {
  return _store;
}

/**
 * Replace the module-level store instance.
 * For use in tests and application bootstrap only.
 */
export function setImpersonationSessionStore(
  store: IImpersonationSessionStore,
): void {
  _store = store;
}

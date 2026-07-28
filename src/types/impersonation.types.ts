/**
 * Impersonation Session Recording Types
 *
 * Defines the data shapes used when an admin impersonates a user account.
 * Every HTTP request made during an impersonation session is recorded so
 * that a reviewer can reconstruct exactly what occurred.
 *
 * Security classification: AUDIT-SENSITIVE
 * Retention policy: 90 days (configurable via IMPERSONATION_RETENTION_DAYS)
 */

// ─── Recorded Request ─────────────────────────────────────────────────────────

/**
 * A single HTTP request captured inside an impersonation session.
 */
export interface ImpersonationRequestRecord {
  /** Monotonically increasing index within the session (0-based) */
  seq: number;
  /** ISO 8601 timestamp when the request was received */
  timestamp: string;
  /** HTTP method */
  method: string;
  /** Full path including query string */
  url: string;
  /**
   * SHA-256 hex digest of the raw response body.
   * Allows integrity checks without storing potentially large bodies.
   */
  responseBodyHash: string;
  /** HTTP response status code */
  responseStatus: number;
  /**
   * Snapshot of mutable resource fields captured BEFORE the request
   * was processed, when a write operation (POST/PUT/PATCH/DELETE) is detected.
   * null when the request was read-only or no diff hook was registered.
   */
  beforeSnapshot: Record<string, unknown> | null;
  /**
   * Snapshot of the same resource fields captured AFTER the response was
   * sent. null for read-only requests.
   */
  afterSnapshot: Record<string, unknown> | null;
  /**
   * Computed diff between beforeSnapshot and afterSnapshot.
   * Each entry describes one field that changed:
   *   { field, before, after }
   * Empty array if there were no changes or the request was read-only.
   */
  diff: ResourceDiffEntry[];
  /** Whether the request was aborted by the client before completion */
  aborted: boolean;
}

/**
 * One field-level change captured by the diff engine.
 */
export interface ResourceDiffEntry {
  /** Dot-separated path to the changed field (e.g. "profile.email") */
  field: string;
  /** Value before the write (undefined means the field did not exist) */
  before: unknown;
  /** Value after the write (undefined means the field was deleted) */
  after: unknown;
}

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * Status of an impersonation session.
 */
export type ImpersonationSessionStatus =
  | "active"   // Token in flight; session still open
  | "closed"   // Admin explicitly ended the session
  | "expired"  // Session TTL elapsed before close
  | "error";   // Session terminated due to an unrecoverable error

/**
 * An impersonation session groups all requests made under a single
 * impersonation token. The token is the primary key.
 */
export interface ImpersonationSession {
  /** Opaque impersonation token (not the JWT – just a session correlation ID) */
  sessionId: string;
  /** User ID of the administrator performing the impersonation */
  adminId: string;
  /** User ID of the account being impersonated */
  targetUserId: string;
  /** ISO 8601 timestamp when the session was opened */
  startedAt: string;
  /**
   * ISO 8601 timestamp when the session was closed / expired.
   * null while the session is still active.
   */
  endedAt: string | null;
  /** Lifecycle status */
  status: ImpersonationSessionStatus;
  /** Ordered list of recorded requests */
  requests: ImpersonationRequestRecord[];
  /**
   * Reason provided by the admin when opening the impersonation session.
   * Required for compliance (GDPR Art. 5 – purpose limitation).
   */
  reason: string;
  /**
   * Number of write operations recorded in this session.
   * Derived field kept in sync as requests are appended.
   */
  writeCount: number;
}

// ─── Store interfaces ─────────────────────────────────────────────────────────

/**
 * Parameters required to open a new impersonation session.
 */
export interface OpenSessionParams {
  adminId: string;
  targetUserId: string;
  reason: string;
  /** Override the auto-generated session ID (useful in tests) */
  sessionId?: string;
}

/**
 * Read-model for listing sessions in the admin review UI.
 * Contains summary fields only – no full request arrays.
 */
export interface ImpersonationSessionSummary {
  sessionId: string;
  adminId: string;
  targetUserId: string;
  startedAt: string;
  endedAt: string | null;
  status: ImpersonationSessionStatus;
  requestCount: number;
  writeCount: number;
  reason: string;
}

/**
 * Pagination params for list queries.
 */
export interface SessionListOptions {
  /** Filter by target user ID */
  targetUserId?: string;
  /** Filter by admin user ID */
  adminId?: string;
  /** Filter sessions that started at or after this ISO timestamp */
  since?: string;
  /** Maximum number of sessions to return (default 50, max 200) */
  limit?: number;
  /** Zero-based page offset */
  offset?: number;
}

// ─── Audit event extension ────────────────────────────────────────────────────

/**
 * Additional fields attached to audit events emitted during an impersonation
 * session. These are merged into AuditEventPayloadV1.context.
 */
export interface ImpersonationAuditContext {
  impersonationSessionId: string;
  adminId: string;
  targetUserId: string;
}

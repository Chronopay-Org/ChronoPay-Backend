/**
 * Impersonation Recorder Middleware
 *
 * When an admin is impersonating a user, every request that passes through
 * this middleware is captured into an ImpersonationSession record so that
 * a reviewer can reconstruct the session post-hoc.
 *
 * Activation:
 *   The middleware activates when `req.impersonation` is populated by the
 *   auth layer that validates the impersonation token.  If that property is
 *   absent the middleware is a transparent pass-through (zero overhead).
 *
 * What is recorded:
 *   - HTTP method and URL (including query string)
 *   - Response status code
 *   - SHA-256 hash of the raw response body (never the body itself)
 *   - For mutating methods (POST / PUT / PATCH / DELETE):
 *       - optional "before" snapshot supplied by the route/repository hook
 *       - optional "after"  snapshot from the same hook
 *       - structured diff of changed fields
 *   - Whether the request was aborted before the response finished
 *
 * Security design notes:
 *   1. We NEVER record raw request/response bodies in the session store –
 *      only a SHA-256 hash of the response body is kept so reviewers can
 *      verify authenticity without exposing PII.
 *   2. Snapshot hooks are opt-in: routes that need diff recording call
 *      `req.impersonation.captureSnapshot(before, after)` before sending
 *      the response. If no hook is invoked the diff array remains empty.
 *   3. Store errors are caught and emitted via the audit logger; they never
 *      propagate to the HTTP handler so a storage failure cannot be used to
 *      bypass recording.
 *   4. The session ID is stored in `req.impersonation.sessionId` and is
 *      injected into every audit event context for correlation.
 *
 * Usage
 * ─────
 * // In app.ts, after the auth middleware that populates req.impersonation:
 * app.use(impersonationRecorder());
 *
 * // In a repository that wants diff capture:
 * async function updateUser(req: Request, id: string, data: UpdateDto) {
 *   const before = await userRepo.findById(id);
 *   const updated = await userRepo.update(id, data);
 *   req.impersonation?.captureSnapshot(before, updated);
 *   return updated;
 * }
 */

import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { defaultAuditLogger } from "../services/auditLogger.js";
import {
  getImpersonationSessionStore,
  IImpersonationSessionStore,
} from "../services/impersonationSessionStore.js";
import {
  ImpersonationRequestRecord,
  ResourceDiffEntry,
} from "../types/impersonation.types.js";
import { IMPERSONATION_AUDIT_ACTIONS } from "../types/auditEvent.js";

// ─── Request augmentation ─────────────────────────────────────────────────────

/**
 * Injected by the auth layer when an impersonation token is validated.
 * The middleware reads this property to decide whether to record the request.
 */
export interface ImpersonationContext {
  /** Unique session identifier */
  sessionId: string;
  /** Admin user performing the impersonation */
  adminId: string;
  /** User account being impersonated */
  targetUserId: string;
  /**
   * Call this from a repository/service BEFORE the response is sent to
   * record a resource diff for the current request.
   * Safe to call more than once; only the last call takes effect.
   */
  captureSnapshot(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): void;
}

// Extend Express Request to hold the impersonation context
declare global {
  namespace Express {
    interface Request {
      /**
       * Present when the request is authenticated with an impersonation token.
       * Populated by the auth middleware; read by impersonationRecorder.
       */
      impersonation?: ImpersonationContext;
    }
  }
}

// ─── Diff engine ──────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Compute a flat diff between two plain objects.
 * Nested objects are traversed with dot-notation paths.
 * Arrays are compared as atomic values (array-level diff only).
 */
export function computeDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ResourceDiffEntry[] {
  if (before === null && after === null) return [];

  const entries: ResourceDiffEntry[] = [];
  const beforeObj = before ?? {};
  const afterObj = after ?? {};

  function walk(
    b: Record<string, unknown>,
    a: Record<string, unknown>,
    prefix: string,
  ): void {
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const key of keys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const bVal = b[key];
      const aVal = a[key];

      if (
        bVal !== null &&
        aVal !== null &&
        typeof bVal === "object" &&
        !Array.isArray(bVal) &&
        typeof aVal === "object" &&
        !Array.isArray(aVal)
      ) {
        // Both are plain objects – recurse
        walk(
          bVal as Record<string, unknown>,
          aVal as Record<string, unknown>,
          path,
        );
      } else if (!Object.is(bVal, aVal)) {
        // Primitive, array, or one-side-null change
        // Deep-equal check for arrays via JSON:
        if (
          Array.isArray(bVal) &&
          Array.isArray(aVal) &&
          JSON.stringify(bVal) === JSON.stringify(aVal)
        ) {
          continue;
        }
        entries.push({ field: path, before: bVal, after: aVal });
      }
    }
  }

  walk(beforeObj, afterObj, "");
  return entries;
}

/**
 * Compute SHA-256 hex digest of a string.
 */
export function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

// ─── Response body interception ───────────────────────────────────────────────

/**
 * Intercept `res.write` and `res.end` to accumulate the raw response body
 * so we can hash it.
 *
 * We cap the accumulated bytes at MAX_BODY_BYTES to prevent memory exhaustion
 * on streaming / large responses.  The hash is computed over the truncated
 * prefix in that case and a `truncated` flag is set.
 */
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

interface BodyCapture {
  chunks: Buffer[];
  totalBytes: number;
  truncated: boolean;
}

function interceptResponseBody(res: Response): BodyCapture {
  const capture: BodyCapture = {
    chunks: [],
    totalBytes: 0,
    truncated: false,
  };

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  const accumulate = (chunk: unknown): void => {
    if (capture.truncated) return;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!buf) return;

    capture.totalBytes += buf.byteLength;
    if (capture.totalBytes > MAX_BODY_BYTES) {
      capture.truncated = true;
      return;
    }
    capture.chunks.push(buf);
  };

  // @ts-expect-error – overriding overloaded method
  res.write = (chunk: unknown, ...args: unknown[]) => {
    accumulate(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };

  // @ts-expect-error – overriding overloaded method
  res.end = (chunk?: unknown, ...args: unknown[]) => {
    if (chunk) accumulate(chunk);
    return (originalEnd as (...a: unknown[]) => Response)(chunk, ...args);
  };

  return capture;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

export interface ImpersonationRecorderOptions {
  /** Override the session store (useful in tests) */
  store?: IImpersonationSessionStore;
}

/**
 * Returns the Express middleware that records impersonated requests.
 *
 * Mount this AFTER the auth middleware that populates `req.impersonation`.
 */
export function impersonationRecorder(
  options: ImpersonationRecorderOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // ── Fast path: not an impersonation request ──────────────────────────────
    if (!req.impersonation) {
      next();
      return;
    }

    const context = req.impersonation;
    const store = options.store ?? getImpersonationSessionStore();

    // ── Snapshot hooks ───────────────────────────────────────────────────────
    let capturedBefore: Record<string, unknown> | null = null;
    let capturedAfter: Record<string, unknown> | null = null;

    // Expose the hook so routes/repositories can register snapshots
    context.captureSnapshot = (
      before: Record<string, unknown> | null,
      after: Record<string, unknown> | null,
    ) => {
      capturedBefore = before;
      capturedAfter = after;
    };

    // ── Body interception ────────────────────────────────────────────────────
    const bodyCapture = interceptResponseBody(res);

    // ── Sequence counter ─────────────────────────────────────────────────────
    // We derive sequence number lazily when the session is retrieved; for now
    // use timestamp-based ordering. Actual seq is set in the finish handler.
    const requestStartTime = Date.now();

    // ── Abort detection ──────────────────────────────────────────────────────
    let aborted = false;
    req.on("aborted", () => {
      aborted = true;
    });
    // Node 14+: 'close' fires on abort too
    req.on("close", () => {
      if (!res.writableEnded) {
        aborted = true;
      }
    });

    // ── Finish handler ───────────────────────────────────────────────────────
    res.on("finish", () => {
      void (async () => {
        try {
          // Compute response body hash
          const rawBody = Buffer.concat(bodyCapture.chunks).toString("utf8");
          const responseBodyHash = hashBody(rawBody);

          // Compute diff for write operations
          const isWrite = WRITE_METHODS.has(req.method.toUpperCase());
          const diff: ResourceDiffEntry[] =
            isWrite && (capturedBefore !== null || capturedAfter !== null)
              ? computeDiff(capturedBefore, capturedAfter)
              : [];

          // Fetch current session to determine seq
          const current = await store.getSession(context.sessionId);
          const seq = current ? current.requests.length : 0;

          const record: ImpersonationRequestRecord = {
            seq,
            timestamp: new Date(requestStartTime).toISOString(),
            method: req.method.toUpperCase(),
            url: req.originalUrl ?? req.url,
            responseBodyHash: bodyCapture.truncated
              ? `${responseBodyHash}:truncated`
              : responseBodyHash,
            responseStatus: res.statusCode,
            beforeSnapshot: isWrite ? capturedBefore : null,
            afterSnapshot: isWrite ? capturedAfter : null,
            diff,
            aborted,
          };

          await store.appendRequest(context.sessionId, record);

          // Emit audit event for write operations
          if (diff.length > 0) {
            // Normalize IPv4-mapped IPv6 addresses (::ffff:x.x.x.x → x.x.x.x)
            // to avoid audit logger IP validation rejecting them.
            const rawIp = req.ip ?? req.socket?.remoteAddress;
            const actorIp = rawIp?.startsWith("::ffff:")
              ? rawIp.slice(7)
              : rawIp;

            void defaultAuditLogger.log(
              IMPERSONATION_AUDIT_ACTIONS.WRITE_DETECTED,
              {
                method: req.method,
                context: {
                  impersonationSessionId: context.sessionId,
                  adminId: context.adminId,
                  targetUserId: context.targetUserId,
                  diffFieldCount: diff.length,
                  fields: diff.map((d) => d.field),
                },
              },
              {
                actorIp,
                resource: req.originalUrl ?? req.url,
                status: res.statusCode,
              },
            );
          }
        } catch (err) {
          // Never propagate storage failures – they must not affect the HTTP
          // response since the response has already been sent.
          void defaultAuditLogger.log(
            "impersonation.recorder.error",
            {
              context: {
                impersonationSessionId: context.sessionId,
                error: err instanceof Error ? err.message : String(err),
              },
            },
            { status: 500 },
          );
        }
      })();
    });

    next();
  };
}

// @ts-nocheck
/**
 * @file src/routes/admin/slots.ts
 *
 * Admin Slot Inventory Routes
 *
 * Every mutation (create / update / delete) is wrapped with the shared
 * `audit()` helper so an immutable audit record is written after every
 * successful change.
 *
 * Endpoints:
 *   POST   /api/v1/admin/slots            – create a slot
 *   PATCH  /api/v1/admin/slots/:id        – update a slot
 *   DELETE /api/v1/admin/slots/:id        – delete a slot
 *   GET    /api/v1/admin/audit/slots      – paginated audit feed
 *
 * Auth:
 *   All routes require the `x-chronopay-admin-token` header or the
 *   `x-chronopay-user-id` + `x-chronopay-role: admin` header pair.
 *
 * Reason requirement:
 *   Every mutation body MUST include `reason` (string, trimmed, ≥ 10 chars).
 *   Missing or invalid reasons return 400 Bad Request.
 *
 * No-op updates:
 *   If a PATCH request does not actually change any field, no audit record is
 *   written and the unchanged slot is returned normally.
 *
 * Rollback safety:
 *   Audit records are only persisted after a successful mutation.  If the
 *   mutation throws, no audit entry is created.  If audit persistence fails
 *   after a successful mutation, a 500 is returned so the caller is aware —
 *   the slot mutation itself is not reversed (the audit layer is best-effort
 *   durable storage; in production this would be a transactional DB write).
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../../middleware/authorization.js";
import { requireAuthenticatedActor } from "../../middleware/auth.js";
import {
  slotService,
  SlotNotFoundError,
  SlotValidationError,
} from "../../services/slotService.js";
import {
  audit,
  slotAuditLogService,
  validateReason,
  SlotAuditValidationError,
  type SlotAuditAction,
  type SlotAuditListOptions,
} from "../../services/slotAuditLog.js";

const router = Router();

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Extracts the actor identity from the authenticated request.
 * Priority: req.auth.userId (JWT/header auth) → "unknown-admin".
 *
 * Client-supplied actor fields in the request body are always ignored.
 */
function getActor(req: Request): string {
  return req.auth?.userId || "unknown-admin";
}

/**
 * Builds optional request metadata for the audit record.
 */
function getRequestMeta(req: Request): { ip?: string; requestId?: string } {
  const ip =
    req.ip?.replace("::ffff:", "") ||
    req.socket?.remoteAddress?.replace("::ffff:", "") ||
    undefined;
  const requestId = (req.headers["x-request-id"] as string | undefined) || undefined;
  return { ip, requestId };
}

/**
 * Serialises a slot object into a plain record suitable for before/after
 * snapshots.  Strips any undefined fields.
 */
function slotSnapshot(slot: unknown): Record<string, unknown> | null {
  if (!slot || typeof slot !== "object") return null;
  return JSON.parse(JSON.stringify(slot));
}

/**
 * Dual-auth guard: accepts either:
 *   - requireAdminToken  (x-chronopay-admin-token header), OR
 *   - requireAuthenticatedActor(["admin"]) (x-chronopay-user-id + role=admin)
 *
 * We run the token check first; if it fails it falls through to the actor
 * check via next().  In practice most callers use one or the other.
 */
function requireAdmin(req: Request, res: Response, next: any): void {
  // Try admin-token auth first
  const adminToken = process.env.CHRONOPAY_ADMIN_TOKEN;
  const providedToken = req.header("x-chronopay-admin-token");
  if (adminToken && providedToken) {
    if (providedToken === adminToken) {
      // Populate a minimal auth context so getActor() works
      if (!req.auth) {
        req.auth = {
          userId: req.header("x-chronopay-user-id") || "admin-token-user",
          role: "admin",
          claims: {} as any,
        };
      }
      return next();
    }
    // Token was provided but wrong – reject immediately
    return res.status(403).json({ success: false, error: "Invalid admin token" });
  }

  // Fall through to header-based role check
  return requireAuthenticatedActor(["admin"])(req, res, next);
}

// ─── POST /api/v1/admin/slots ─────────────────────────────────────────────────

/**
 * @route POST /api/v1/admin/slots
 * @desc  Create a new slot.  Writes an audit record on success.
 * @access Admin only
 *
 * Body:
 *   - professional  {string}  required
 *   - startTime     {number}  required (epoch ms)
 *   - endTime       {number}  required (epoch ms)
 *   - reason        {string}  required, ≥ 10 chars
 *   - ...any other valid slot fields
 *
 * Responses:
 *   201  slot created + audit record persisted
 *   400  missing/invalid reason
 *   422  slot validation failure
 *   401/403 auth failure
 */
router.post("/", requireAdmin, async (req: Request, res: Response) => {
  // ── Validate reason ────────────────────────────────────────────────────────
  let reason: string;
  try {
    reason = validateReason(req.body?.reason);
  } catch (err) {
    if (err instanceof SlotAuditValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    throw err;
  }

  const actor = getActor(req);
  const requestMeta = getRequestMeta(req);

  // Strip reason from the slot payload before passing to the service
  const { reason: _r, ...slotData } = req.body ?? {};

  try {
    // For creates we can't know the resource ID before the mutation, so we
    // run the mutation first then persist the audit record directly.
    const slot = await slotService.createSlot(slotData);
    const resourceId = String(slot.id);

    // Persist the audit record after a successful mutation.
    slotAuditLogService.persist({
      actor,
      action: "create",
      resourceId,
      before: null,
      after: slotSnapshot(slot),
      reason,
      requestMeta,
    });

    return res.status(201).json({
      success: true,
      slot,
      meta: { invalidatedKeys: ["slots:list:all"] },
    });
  } catch (err: any) {
    if (err instanceof SlotValidationError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PATCH /api/v1/admin/slots/:id ───────────────────────────────────────────

/**
 * @route PATCH /api/v1/admin/slots/:id
 * @desc  Update a slot.  Writes an audit record only when at least one field
 *        changes (no-op updates are silently skipped).
 * @access Admin only
 *
 * Body:
 *   - reason  {string}  required, ≥ 10 chars
 *   - ...fields to update
 *
 * Responses:
 *   200  updated slot returned; audit record written if changed
 *   400  missing/invalid reason
 *   404  slot not found
 *   422  slot validation failure
 *   401/403 auth failure
 */
router.patch("/:id", requireAdmin, async (req: Request, res: Response) => {
  // ── Validate reason ────────────────────────────────────────────────────────
  let reason: string;
  try {
    reason = validateReason(req.body?.reason);
  } catch (err) {
    if (err instanceof SlotAuditValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    throw err;
  }

  const actor = getActor(req);
  const requestMeta = getRequestMeta(req);
  const { id } = req.params;

  const { reason: _r, ...updateData } = req.body ?? {};

  try {
    const updatedSlot = await audit<any>(
      { actor, action: "update", resourceId: String(id), reason, requestMeta },
      async () => {
        try {
          return slotSnapshot(await slotService.findById(id));
        } catch {
          return null;
        }
      },
      async () => slotService.updateSlot(id, updateData),
      async (updated) => slotSnapshot(updated),
      slotAuditLogService,
    );

    return res.json({
      success: true,
      slot: updatedSlot,
      meta: { invalidatedKeys: ["slots:list:all"] },
    });
  } catch (err: any) {
    if (err instanceof SlotNotFoundError) {
      return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof SlotValidationError) {
      return res.status(422).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/v1/admin/slots/:id ──────────────────────────────────────────

/**
 * @route DELETE /api/v1/admin/slots/:id
 * @desc  Delete a slot.  Writes an audit record on success.
 * @access Admin only
 *
 * Body:
 *   - reason  {string}  required, ≥ 10 chars
 *
 * Responses:
 *   200  slot deleted; audit record written
 *   400  missing/invalid reason
 *   404  slot not found
 *   401/403 auth failure
 */
router.delete("/:id", requireAdmin, async (req: Request, res: Response) => {
  // ── Validate reason ────────────────────────────────────────────────────────
  let reason: string;
  try {
    reason = validateReason(req.body?.reason);
  } catch (err) {
    if (err instanceof SlotAuditValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    throw err;
  }

  const actor = getActor(req);
  const requestMeta = getRequestMeta(req);
  const { id } = req.params;

  try {
    const deletedId = await audit<any>(
      { actor, action: "delete", resourceId: String(id), reason, requestMeta },
      async () => {
        try {
          return slotSnapshot(await slotService.findById(id));
        } catch {
          return null;
        }
      },
      async () => slotService.deleteSlot(id),
      async () => null, // no after-state for deletes
      slotAuditLogService,
    );

    return res.json({ success: true, deletedSlotId: deletedId });
  } catch (err: any) {
    if (err instanceof SlotNotFoundError) {
      return res.status(404).json({ success: false, error: "Slot not found" });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/v1/admin/audit/slots ───────────────────────────────────────────

/**
 * @route GET /api/v1/admin/audit/slots
 * @desc  Paginated, filterable audit feed for slot inventory mutations.
 *        Results are returned newest first.
 * @access Admin only
 *
 * Query parameters:
 *   page        {number}  1-based page number (default 1)
 *   limit       {number}  results per page, 1–200 (default 20)
 *   actor       {string}  filter by actor user ID
 *   action      {string}  filter by action: create | update | delete
 *   resourceId  {string}  filter by slot ID
 *   since       {string}  ISO-8601 lower bound for timestamp
 *   until       {string}  ISO-8601 upper bound for timestamp
 *
 * Responses:
 *   200  paginated audit feed
 *   400  invalid query parameters
 *   401/403 auth failure
 */
router.get("/audit/slots", requireAdmin, (req: Request, res: Response) => {
  const pageRaw = req.query.page !== undefined ? parseInt(String(req.query.page), 10) : 1;
  const limitRaw = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : 20;

  if (isNaN(pageRaw) || pageRaw < 1) {
    return res.status(400).json({ success: false, error: "page must be a positive integer" });
  }
  if (isNaN(limitRaw) || limitRaw < 1 || limitRaw > 200) {
    return res.status(400).json({ success: false, error: "limit must be between 1 and 200" });
  }

  const actionRaw = req.query.action as string | undefined;
  const validActions = ["create", "update", "delete"];
  if (actionRaw && !validActions.includes(actionRaw)) {
    return res.status(400).json({
      success: false,
      error: `action must be one of: ${validActions.join(", ")}`,
    });
  }

  const sinceRaw = req.query.since as string | undefined;
  const untilRaw = req.query.until as string | undefined;

  if (sinceRaw && isNaN(new Date(sinceRaw).getTime())) {
    return res.status(400).json({ success: false, error: "since must be a valid ISO-8601 date" });
  }
  if (untilRaw && isNaN(new Date(untilRaw).getTime())) {
    return res.status(400).json({ success: false, error: "until must be a valid ISO-8601 date" });
  }

  const opts: SlotAuditListOptions = {
    page: pageRaw,
    limit: limitRaw,
    actor: (req.query.actor as string | undefined) || undefined,
    action: (actionRaw as SlotAuditAction) || undefined,
    resourceId: (req.query.resourceId as string | undefined) || undefined,
    since: sinceRaw,
    until: untilRaw,
  };

  const result = slotAuditLogService.list(opts);

  return res.json({
    success: true,
    data: result.data,
    page: result.page,
    limit: result.limit,
    total: result.total,
  });
});

export { router };
export default router;

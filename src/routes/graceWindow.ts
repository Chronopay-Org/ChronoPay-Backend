/**
 * graceWindow.ts
 * --------------
 * Admin REST endpoints for per-slot-category no-show grace-window
 * configuration.
 *
 * All routes require a valid admin token (x-chronopay-admin-token header).
 *
 * Endpoints
 * ---------
 *   GET    /api/v1/admin/slot-categories/grace-windows
 *     List all explicitly configured categories with their grace windows.
 *     Categories that have no explicit config use the system default and
 *     are NOT included in this list.
 *
 *   GET    /api/v1/admin/slot-categories/:category/grace-window
 *     Get the effective grace window for a specific category.
 *     Returns the configured value when set, otherwise returns the
 *     default so callers always get a usable number.
 *
 *   PUT    /api/v1/admin/slot-categories/:category/grace-window
 *     Set or update the grace window for a category.
 *     Body: { graceWindowSeconds: number, reason?: string }
 *
 *   DELETE /api/v1/admin/slot-categories/:category/grace-window
 *     Remove the category-specific override; the category reverts to
 *     the system default.  Body: { reason?: string }
 *
 *   GET    /api/v1/admin/slot-categories/:category/grace-window/history
 *     Retrieve the immutable change history for a category.
 *     Supports ?limit and ?offset for pagination.
 *
 *   GET    /api/v1/admin/slot-categories/grace-windows/history
 *     Retrieve change history across ALL categories (paginated).
 */

import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import {
  GraceWindowService,
  GraceWindowValidationError,
  DEFAULT_GRACE_WINDOW_SECONDS,
  MIN_GRACE_WINDOW_SECONDS,
  MAX_GRACE_WINDOW_SECONDS,
  getGraceWindowService,
} from "../services/graceWindowService.js";

// ─── Router factory ───────────────────────────────────────────────────────────

/**
 * Create the grace-window router.
 *
 * @param service - Inject a custom service instance (useful in tests).
 *                  Defaults to the application singleton.
 */
export function createGraceWindowRouter(service?: GraceWindowService): Router {
  const router = Router();
  const svc = service ?? getGraceWindowService();

  // ── GET /slot-categories/grace-windows ──────────────────────────────────

  /**
   * @route GET /api/v1/admin/slot-categories/grace-windows
   * @desc  List all explicitly configured categories.
   * @access Admin token
   */
  router.get(
    "/slot-categories/grace-windows",
    requireAdminToken,
    (_req: Request, res: Response) => {
      const configs = svc.list();
      return res.status(200).json({
        success: true,
        configs,
        defaultGraceWindowSeconds: DEFAULT_GRACE_WINDOW_SECONDS,
      });
    },
  );

  // ── GET /slot-categories/grace-windows/history ──────────────────────────

  /**
   * @route GET /api/v1/admin/slot-categories/grace-windows/history
   * @desc  Retrieve change history across all categories (paginated).
   * @access Admin token
   */
  router.get(
    "/slot-categories/grace-windows/history",
    requireAdminToken,
    (req: Request, res: Response) => {
      const { limit, offset, error: pageError } = parsePagination(req);
      if (pageError) {
        return res.status(400).json({ success: false, error: pageError });
      }

      const allHistory = svc.getHistory();
      const total = allHistory.length;
      const page = allHistory.slice(offset, offset + limit);

      return res.status(200).json({
        success: true,
        history: page,
        total,
        limit,
        offset,
      });
    },
  );

  // ── GET /slot-categories/:category/grace-window ─────────────────────────

  /**
   * @route GET /api/v1/admin/slot-categories/:category/grace-window
   * @desc  Get the effective grace window for a category.
   * @access Admin token
   */
  router.get(
    "/slot-categories/:category/grace-window",
    requireAdminToken,
    (req: Request, res: Response) => {
      const category = req.params.category?.trim();
      if (!category) {
        return res.status(400).json({ success: false, error: "category is required" });
      }

      const config = svc.get(category);
      const effectiveSeconds = svc.resolve(category);

      return res.status(200).json({
        success: true,
        category,
        graceWindowSeconds: effectiveSeconds,
        isDefault: config === undefined,
        defaultGraceWindowSeconds: DEFAULT_GRACE_WINDOW_SECONDS,
        config: config ?? null,
      });
    },
  );

  // ── PUT /slot-categories/:category/grace-window ─────────────────────────

  /**
   * @route PUT /api/v1/admin/slot-categories/:category/grace-window
   * @desc  Set or update the grace window for a category.
   * @access Admin token
   */
  router.put(
    "/slot-categories/:category/grace-window",
    requireAdminToken,
    async (req: Request, res: Response) => {
      const category = req.params.category?.trim();
      if (!category) {
        return res.status(400).json({ success: false, error: "category is required" });
      }

      const { graceWindowSeconds, reason } = req.body ?? {};

      // graceWindowSeconds is required and must be an integer in range.
      if (graceWindowSeconds === undefined || graceWindowSeconds === null) {
        return res.status(400).json({
          success: false,
          error: "graceWindowSeconds is required",
        });
      }
      if (typeof graceWindowSeconds !== "number" || !Number.isFinite(graceWindowSeconds)) {
        return res.status(422).json({
          success: false,
          error: "graceWindowSeconds must be a finite number",
        });
      }
      if (!Number.isInteger(graceWindowSeconds)) {
        return res.status(422).json({
          success: false,
          error: "graceWindowSeconds must be an integer",
        });
      }
      if (
        graceWindowSeconds < MIN_GRACE_WINDOW_SECONDS ||
        graceWindowSeconds > MAX_GRACE_WINDOW_SECONDS
      ) {
        return res.status(422).json({
          success: false,
          error: `graceWindowSeconds must be between ${MIN_GRACE_WINDOW_SECONDS} and ${MAX_GRACE_WINDOW_SECONDS}`,
        });
      }
      if (reason !== undefined && typeof reason !== "string") {
        return res.status(422).json({ success: false, error: "reason must be a string" });
      }
      if (reason !== undefined && reason.length > 500) {
        return res.status(422).json({
          success: false,
          error: "reason must be 500 characters or fewer",
        });
      }

      // Derive changedBy from the admin token header (best-effort).
      const changedBy = deriveActorId(req);

      try {
        const config = await svc.set({
          category,
          graceWindowSeconds,
          changedBy,
          reason,
        });
        return res.status(200).json({ success: true, config });
      } catch (err: any) {
        if (err instanceof GraceWindowValidationError) {
          return res.status(422).json({ success: false, error: err.message });
        }
        return res.status(500).json({
          success: false,
          error: err.message ?? "Failed to update grace window config",
        });
      }
    },
  );

  // ── DELETE /slot-categories/:category/grace-window ──────────────────────

  /**
   * @route DELETE /api/v1/admin/slot-categories/:category/grace-window
   * @desc  Remove the category override and revert to the system default.
   * @access Admin token
   */
  router.delete(
    "/slot-categories/:category/grace-window",
    requireAdminToken,
    async (req: Request, res: Response) => {
      const category = req.params.category?.trim();
      if (!category) {
        return res.status(400).json({ success: false, error: "category is required" });
      }

      const { reason } = req.body ?? {};
      if (reason !== undefined && typeof reason !== "string") {
        return res.status(422).json({ success: false, error: "reason must be a string" });
      }

      const changedBy = deriveActorId(req);

      try {
        const deleted = await svc.delete(category, changedBy, reason);
        if (!deleted) {
          return res.status(404).json({
            success: false,
            error: `No grace window config found for category "${category}"`,
          });
        }
        return res.status(200).json({
          success: true,
          message: `Grace window config for "${category}" deleted. Reverted to default (${DEFAULT_GRACE_WINDOW_SECONDS}s).`,
          defaultGraceWindowSeconds: DEFAULT_GRACE_WINDOW_SECONDS,
        });
      } catch (err: any) {
        if (err instanceof GraceWindowValidationError) {
          return res.status(422).json({ success: false, error: err.message });
        }
        return res.status(500).json({
          success: false,
          error: err.message ?? "Failed to delete grace window config",
        });
      }
    },
  );

  // ── GET /slot-categories/:category/grace-window/history ─────────────────

  /**
   * @route GET /api/v1/admin/slot-categories/:category/grace-window/history
   * @desc  Retrieve the immutable change history for a specific category.
   * @access Admin token
   */
  router.get(
    "/slot-categories/:category/grace-window/history",
    requireAdminToken,
    (req: Request, res: Response) => {
      const category = req.params.category?.trim();
      if (!category) {
        return res.status(400).json({ success: false, error: "category is required" });
      }

      const { limit, offset, error: pageError } = parsePagination(req);
      if (pageError) {
        return res.status(400).json({ success: false, error: pageError });
      }

      const allHistory = svc.getHistory(category);
      const total = allHistory.length;
      const page = allHistory.slice(offset, offset + limit);

      return res.status(200).json({
        success: true,
        category,
        history: page,
        total,
        limit,
        offset,
      });
    },
  );

  return router;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePagination(req: Request): {
  limit: number;
  offset: number;
  error?: string;
} {
  let limit = 50;
  let offset = 0;

  if (req.query.limit !== undefined) {
    const parsed = parseInt(String(req.query.limit), 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 200) {
      return { limit, offset, error: "limit must be between 1 and 200" };
    }
    limit = parsed;
  }

  if (req.query.offset !== undefined) {
    const parsed = parseInt(String(req.query.offset), 10);
    if (isNaN(parsed) || parsed < 0) {
      return { limit, offset, error: "offset must be a non-negative integer" };
    }
    offset = parsed;
  }

  return { limit, offset };
}

/**
 * Extract a best-effort actor ID from the request.
 * In practice this comes from the JWT payload once the auth middleware
 * populates `req.auth`.  For token-only admin calls we use the token
 * header value as a stable identifier.
 */
function deriveActorId(req: Request): string {
  return (
    (req as any).auth?.userId ??
    req.header("x-chronopay-admin-token") ??
    "admin"
  );
}

// Export a default router backed by the application singleton.
export default createGraceWindowRouter();

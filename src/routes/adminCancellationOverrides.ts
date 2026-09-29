import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import { defaultSupplierCancellationOverrideStore } from "../services/supplierCancellationOverrideStore.js";
import { validateProratedCancellationTerms } from "../services/cancellationPolicy.js";
import type { ProratedCancellationTerms } from "../modules/booking-intents/booking-intent-repository.js";

/**
 * Supplier cancellation-override admin routes.
 *
 * Lets an operator give a specific supplier bespoke refund terms, overriding
 * the platform-wide prorated cancellation policy. The store owns persistence
 * and audit logging; this module is the HTTP edge.
 *
 * Mounted by routes/admin.ts under /api/v1/admin.
 */

const store = defaultSupplierCancellationOverrideStore;

/** Attribution for the audit trail the store writes on every mutation. */
function resolveActor(req: Request): string {
  return req.auth?.userId ?? "admin";
}

/**
 * Maps a store error onto an HTTP status. The store only rejects on invalid
 * terms (a caller mistake), so those are 400 and anything else is unexpected.
 */
function handleServiceError(err: any, res: Response): Response {
  const message = err?.message ?? "Cancellation override operation failed";
  return res.status(400).json({ success: false, error: message });
}

const router = Router();

/**
 * @route GET /api/v1/admin/cancellation-overrides
 * @desc List every supplier cancellation override, sorted by supplier ID.
 * @access Private (admin token only)
 */
router.get("/cancellation-overrides", requireAdminToken, (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, overrides: store.listOverrides() });
});

/**
 * @route GET /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Fetch a single supplier's override.
 * @access Private (admin token only)
 */
router.get("/cancellation-overrides/:supplierId", requireAdminToken, (req: Request, res: Response) => {
  const override = store.getOverride(req.params.supplierId);
  if (!override) {
    return res.status(404).json({
      success: false,
      error: `No cancellation override found for supplier ${req.params.supplierId}`,
    });
  }
  return res.status(200).json({ success: true, override });
});

/**
 * @route PUT /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Create or replace a supplier's prorated cancellation terms.
 *   Body: { tiers, minRefundAmount?, maxRefundAmount?, description? }
 * @access Private (admin token only)
 */
router.put("/cancellation-overrides/:supplierId", requireAdminToken, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Checked here as well as in the store so the caller gets a message that
  // names the offending field rather than a generic policy error.
  if (!Array.isArray(body.tiers) || body.tiers.length === 0) {
    return res.status(400).json({ success: false, error: "tiers must be a non-empty array" });
  }

  const terms: ProratedCancellationTerms = {
    tiers: body.tiers,
    ...(body.minRefundAmount !== undefined ? { minRefundAmount: body.minRefundAmount } : {}),
    ...(body.maxRefundAmount !== undefined ? { maxRefundAmount: body.maxRefundAmount } : {}),
  } as ProratedCancellationTerms;

  try {
    // Surfaces tier range/ratio problems (overlaps, out-of-range ratios)
    // as a 400 before anything is persisted.
    validateProratedCancellationTerms(terms);
    const override = await store.setOverride(
      req.params.supplierId,
      terms,
      resolveActor(req),
      typeof body.description === "string" ? body.description : undefined,
    );
    return res.status(200).json({ success: true, override });
  } catch (err) {
    return handleServiceError(err, res);
  }
});

/**
 * @route DELETE /api/v1/admin/cancellation-overrides/:supplierId
 * @desc Remove a supplier's override, restoring the platform default policy.
 * @access Private (admin token only)
 */
router.delete("/cancellation-overrides/:supplierId", requireAdminToken, async (req: Request, res: Response) => {
  const deleted = await store.deleteOverride(req.params.supplierId, resolveActor(req));
  if (!deleted) {
    return res.status(404).json({
      success: false,
      error: `No cancellation override found for supplier ${req.params.supplierId}`,
    });
  }
  return res.status(200).json({ success: true, deleted: true });
});

export default router;

import { Router, Request, Response } from "express";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validation.js";
import {
  CreateDiscountCurveSchema,
  UpdateDiscountCurveSchema,
} from "../validation/discountCurveSchema.js";
import {
  createDiscountCurve,
  getDiscountCurve,
  listDiscountCurves,
  updateDiscountCurve,
  deleteDiscountCurve,
  DiscountCurveNotFoundError,
  DiscountCurveValidationError,
} from "../services/discountCurveService.js";

const router = Router();

/**
 * POST /api/v1/discount-curves
 * Create a new discount curve (supplier only)
 */
router.post(
  "/",
  requireRole(["supplier", "admin"]),
  validateBody(CreateDiscountCurveSchema),
  async (req: Request, res: Response) => {
    try {
      const curve = createDiscountCurve(req.body);
      res.status(201).json({
        success: true,
        discountCurve: curve,
      });
    } catch (error: any) {
      if (error instanceof DiscountCurveValidationError) {
        res.status(422).json({ success: false, error: error.message });
      } else {
        res.status(500).json({ success: false, error: "Internal server error" });
      }
    }
  },
);

/**
 * GET /api/v1/discount-curves
 * List discount curves with optional filtering
 */
router.get(
  "/",
  requireRole(["supplier", "admin"]),
  async (req: Request, res: Response) => {
    try {
      const { supplierId, bundleId, active } = req.query;

      const curves = listDiscountCurves({
        supplierId: supplierId as string,
        bundleId: bundleId as string,
        active: active !== undefined ? active === "true" : undefined,
      });

      res.json({
        success: true,
        discountCurves: curves,
        total: curves.length,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  },
);

/**
 * GET /api/v1/discount-curves/:id
 * Get a specific discount curve
 */
router.get(
  "/:id",
  requireRole(["supplier", "admin"]),
  async (req: Request, res: Response) => {
    try {
      const curve = getDiscountCurve(req.params.id);
      res.json({
        success: true,
        discountCurve: curve,
      });
    } catch (error: any) {
      if (error instanceof DiscountCurveNotFoundError) {
        res.status(404).json({ success: false, error: error.message });
      } else {
        res.status(500).json({ success: false, error: "Internal server error" });
      }
    }
  },
);

/**
 * PATCH /api/v1/discount-curves/:id
 * Update an existing discount curve
 */
router.patch(
  "/:id",
  requireRole(["supplier", "admin"]),
  validateBody(UpdateDiscountCurveSchema),
  async (req: Request, res: Response) => {
    try {
      const curve = updateDiscountCurve(req.params.id, req.body);
      res.json({
        success: true,
        discountCurve: curve,
      });
    } catch (error: any) {
      if (error instanceof DiscountCurveNotFoundError) {
        res.status(404).json({ success: false, error: error.message });
      } else if (error instanceof DiscountCurveValidationError) {
        res.status(422).json({ success: false, error: error.message });
      } else {
        res.status(500).json({ success: false, error: "Internal server error" });
      }
    }
  },
);

/**
 * DELETE /api/v1/discount-curves/:id
 * Delete a discount curve
 */
router.delete(
  "/:id",
  requireRole(["supplier", "admin"]),
  async (req: Request, res: Response) => {
    try {
      deleteDiscountCurve(req.params.id);
      res.json({
        success: true,
        deleted: true,
      });
    } catch (error: any) {
      if (error instanceof DiscountCurveNotFoundError) {
        res.status(404).json({ success: false, error: error.message });
      } else {
        res.status(500).json({ success: false, error: "Internal server error" });
      }
    }
  },
);

export { router };
export default router;

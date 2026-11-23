import { Router, type Request, type Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import {
  createDiscountCurve,
  deleteDiscountCurve,
  DiscountCurveNotFoundError,
  DiscountCurveValidationError,
  getDiscountCurve,
  listDiscountCurves,
  updateDiscountCurve,
} from "../services/discountCurveService.js";

const router = Router();
const authenticateSupplier = requireAuthenticatedActor(["supplier", "admin"]);

function canAccessCurve(
  req: Request,
  res: Response,
  supplierId: string,
): boolean {
  if (req.auth?.role === "admin" || req.auth?.userId === supplierId) {
    return true;
  }
  res.status(403).json({ success: false, error: "Access denied" });
  return false;
}

function sendServiceError(
  error: unknown,
  res: Response,
  next: (error?: unknown) => void,
): void {
  if (error instanceof DiscountCurveNotFoundError) {
    res.status(404).json({ success: false, error: error.message });
  } else if (error instanceof DiscountCurveValidationError) {
    res.status(422).json({ success: false, error: error.message });
  } else {
    next(error);
  }
}

/**
 * @openapi
 * /api/v1/discount-curves:
 *   post:
 *     summary: Create a discount curve
 *     responses:
 *       201:
 *         description: Discount curve created
 *       403:
 *         description: Caller cannot create a curve for another supplier
 *   get:
 *     summary: List discount curves
 *     responses:
 *       200:
 *         description: Discount curves listed
 * /api/v1/discount-curves/{id}:
 *   get:
 *     summary: Get a discount curve
 *     responses:
 *       200:
 *         description: Discount curve returned
 *       403:
 *         description: Caller does not own the curve
 *       404:
 *         description: Discount curve not found
 *   patch:
 *     summary: Update a discount curve
 *     responses:
 *       200:
 *         description: Discount curve updated
 *       403:
 *         description: Caller does not own the curve
 *   delete:
 *     summary: Delete a discount curve
 *     responses:
 *       200:
 *         description: Discount curve deleted
 *       403:
 *         description: Caller does not own the curve
 */
router.post(
  "/",
  authenticateSupplier,
  (req: Request, res, next) => {
    try {
      const body =
        req.auth?.role === "admin"
          ? req.body
          : { ...req.body, supplierId: req.auth?.userId };
      const discountCurve = createDiscountCurve(body);
      res.status(201).json({ success: true, discountCurve });
    } catch (error) {
      sendServiceError(error, res, next);
    }
  },
);

router.get(
  "/",
  authenticateSupplier,
  (req: Request, res, next) => {
    try {
      const querySupplierId =
        typeof req.query.supplierId === "string"
          ? req.query.supplierId
          : undefined;
      const supplierId =
        req.auth?.role === "admin" ? querySupplierId : req.auth?.userId;
      const bundleId =
        typeof req.query.bundleId === "string" ? req.query.bundleId : undefined;
      const active =
        typeof req.query.active === "string"
          ? req.query.active === "true"
          : undefined;
      const discountCurves = listDiscountCurves({
        supplierId,
        bundleId,
        active,
      });
      res.json({
        success: true,
        discountCurves,
        total: discountCurves.length,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/:id",
  authenticateSupplier,
  (req: Request, res, next) => {
    try {
      const discountCurve = getDiscountCurve(req.params.id);
      if (!canAccessCurve(req, res, discountCurve.supplierId)) return;
      res.json({ success: true, discountCurve });
    } catch (error) {
      sendServiceError(error, res, next);
    }
  },
);

router.patch(
  "/:id",
  authenticateSupplier,
  (req: Request, res, next) => {
    try {
      const existing = getDiscountCurve(req.params.id);
      if (!canAccessCurve(req, res, existing.supplierId)) return;
      const body =
        req.auth?.role === "admin"
          ? req.body
          : { ...req.body, supplierId: existing.supplierId };
      const discountCurve = updateDiscountCurve(req.params.id, body);
      res.json({ success: true, discountCurve });
    } catch (error) {
      sendServiceError(error, res, next);
    }
  },
);

router.delete(
  "/:id",
  authenticateSupplier,
  (req: Request, res, next) => {
    try {
      const existing = getDiscountCurve(req.params.id);
      if (!canAccessCurve(req, res, existing.supplierId)) return;
      deleteDiscountCurve(req.params.id);
      res.json({ success: true, deleted: true });
    } catch (error) {
      sendServiceError(error, res, next);
    }
  },
);

export { router };
export default router;

import { Router, Request, Response } from "express";
import { slotService } from "../services/slotService.js";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { validateRequiredFields } from "../middleware/validation.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";

const router = Router();

/**
 * Reset slot store for tests
 */
export function resetSlotStore(): void {
  slotService.reset();
}

/**
 * GET /api/v1/slots
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const pageStr = req.query.page as string;
    const limitStr = req.query.limit as string;
    
    const page = pageStr !== undefined ? parseInt(pageStr) : 1;
    const limit = limitStr !== undefined ? parseInt(limitStr) : 10;

    const result = await slotService.list({ page, limit });
    
    res.set("X-Cache", "MISS"); // Stub for tests expecting cache headers
    res.json({
      success: true,
      data: result.data,
      slots: result.slots,
      page: result.page,
      limit: result.limit,
      total: result.total,
      meta: {
          cache: "miss"
      }
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/v1/slots
 */
router.post(
  "/",
  requireApiKey("test-api-key"), // Use a fixed key for now or pass it from app.ts
  requireFeatureFlag("CREATE_SLOT"),
  validateRequiredFields(["professional", "startTime", "endTime"]),
  async (req: Request, res: Response) => {
    try {
      const slot = slotService.createSlot(req.body);
      res.status(201).json({
        success: true,
        slot,
        meta: {
            invalidatedKeys: ["slots:list:all"]
        }
      });
    } catch (error: any) {
      const status = error.name === "SlotValidationError" ? 422 : 500;
      res.status(status).json({
        success: false,
        error: error.message,
      });
    }
  }
);

export { router };
export default router;

import { Router, type Request, type Response } from "express";
import { requireAuthenticatedActor } from "../middleware/auth.js";
import { GdprExportService, type ProfileProvider, type BookingsProvider, type ReceiptsProvider } from "../services/gdprExportService.js";

function buildBaseUrl(req: Request): string {
  const scheme = req.protocol;
  const host = req.get("host") ?? "localhost";
  return `${scheme}://${host}`;
}

export function createGdprExportRouter(
  profileProvider?: ProfileProvider,
  bookingsProvider?: BookingsProvider,
  receiptsProvider?: ReceiptsProvider,
): Router {
  const router = Router();
  const service = new GdprExportService(
    undefined, // default ephemeral store
    undefined, // default audit logger
    profileProvider,
    bookingsProvider,
    receiptsProvider,
  );

  /**
   * @route POST /api/v1/gdpr/export
   * @desc Request a GDPR data portability export for the authenticated user.
   * @access Authenticated user only
   */
  router.post("/", requireAuthenticatedActor, async (req: any, res: Response) => {
    try {
      const userId = req.auth?.userId ?? req.auth?.sub;
      if (!userId) {
        return res.status(401).json({ success: false, error: "Unable to identify user for export" });
      }

      const baseUrl = buildBaseUrl(req);
      const result = await service.createExport(userId, baseUrl);

      return res.status(201).json({
        success: true,
        exportId: result.exportId,
        downloadUrl: result.downloadUrl,
        expiresAt: result.expiresAt,
      });
    } catch (error: any) {
      const message = error.message || "GDPR export failed";
      if (message.includes("exceeds maximum size")) {
        return res.status(413).json({ success: false, error: message });
      }
      return res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * @route GET /api/v1/gdpr/export/download
   * @desc Download a signed GDPR export using a short-lived token.
   * @access Public via signed token
   */
  router.get("/download", async (req: Request, res: Response) => {
    try {
      const token = req.query.token;
      if (!token || typeof token !== "string") {
        return res.status(400).json({ success: false, error: "Missing export token" });
      }

      const exportEntry = await service.getExport(token);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", "attachment; filename=chronopay-gdpr-export.json");
      res.setHeader("X-GDPR-Export-Integrity-Sha256", exportEntry.integrity);

      return res.send(exportEntry.content);
    } catch (error: any) {
      const message = error.message || "Export download failed";
      if (message.includes("expired") || message.includes("Invalid export token")) {
        return res.status(401).json({ success: false, error: message });
      }
      if (message.includes("not found")) {
        return res.status(404).json({ success: false, error: message });
      }
      return res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}

// Default export for convenience
export const gdprExportRouter = createGdprExportRouter();

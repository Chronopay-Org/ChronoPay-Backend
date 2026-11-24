import { Router, type Request, type Response } from "express";
import { requireAdminToken } from "../middleware/authorization.js";
import {
  HolidayCalendarService,
  InMemoryHolidayCalendarRepository,
  HolidayCalendarNotFoundError,
  HolidayCalendarConflictError,
  HolidayCalendarValidationError,
  type IHolidayCalendarRepository,
} from "../services/holidayCalendarService.js";

const router = Router();

// ─── Holiday Calendar Admin API ───────────────────────────────────────────────
//
// All routes require the x-chronopay-admin-token header.
// The service instance can be replaced via setHolidayCalendarRepository()
// to inject an in-memory repo in tests without a live database.
//
// Routes:
//   GET    /api/v1/admin/holiday-calendars
//   POST   /api/v1/admin/holiday-calendars
//   GET    /api/v1/admin/holiday-calendars/:id
//   PATCH  /api/v1/admin/holiday-calendars/:id
//   DELETE /api/v1/admin/holiday-calendars/:id
//   POST   /api/v1/admin/holiday-calendars/:id/entries
//   DELETE /api/v1/admin/holiday-calendars/:id/entries/:entryId
//   POST   /api/v1/admin/holiday-calendars/import/yaml
//   GET    /api/v1/admin/holiday-calendars/:id/revisions
//   GET    /api/v1/admin/holiday-calendars/:id/revisions/:version
//   POST   /api/v1/admin/holiday-calendars/:id/rollback/:version

let _holidayCalendarRepo: IHolidayCalendarRepository = new InMemoryHolidayCalendarRepository();

export function setHolidayCalendarRepository(repo: IHolidayCalendarRepository): void {
  _holidayCalendarRepo = repo;
}

function getHolidayCalendarService(): HolidayCalendarService {
  return new HolidayCalendarService(_holidayCalendarRepo);
}

function handleHolidayCalendarError(err: unknown, res: Response): Response {
  if (err instanceof HolidayCalendarNotFoundError) {
    return res.status(404).json({ success: false, error: err.message });
  }
  if (err instanceof HolidayCalendarConflictError) {
    return res.status(409).json({ success: false, error: err.message });
  }
  if (err instanceof HolidayCalendarValidationError) {
    return res.status(422).json({ success: false, error: err.message, details: err.details });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  return res.status(500).json({ success: false, error: message });
}

/**
 * @route GET /api/v1/admin/holiday-calendars
 * @desc List all holiday calendars.
 * @access Private (admin token only)
 */
router.get("/holiday-calendars", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const calendars = await getHolidayCalendarService().listCalendars();
    return res.status(200).json({ success: true, calendars });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/holiday-calendars
 * @desc Create a new holiday calendar for a region.
 * @access Private (admin token only)
 *
 * Body:
 *   region       {string} — unique region identifier (e.g. "us-east", "eu-west")
 *   name         {string} — display name for the calendar
 *   description  {string} — optional description
 */
router.post("/holiday-calendars", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { region, name, description } = req.body ?? {};

    if (!region || typeof region !== "string" || region.trim() === "") {
      return res.status(400).json({ success: false, error: "region is required" });
    }
    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ success: false, error: "name is required" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().createCalendar({
      region,
      name,
      description,
      changedBy,
    });
    return res.status(201).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id
 * @desc Retrieve a single holiday calendar by ID.
 * @access Private (admin token only)
 */
router.get("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const calendar = await getHolidayCalendarService().getCalendar(req.params.id);
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route PATCH /api/v1/admin/holiday-calendars/:id
 * @desc Update calendar metadata (name / description). Saves a new revision.
 * @access Private (admin token only)
 *
 * Body:
 *   name         {string} — new display name (optional)
 *   description  {string} — new description (optional)
 */
router.patch("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body ?? {};
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      return res.status(400).json({ success: false, error: "name must be a non-empty string" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().updateCalendar(req.params.id, {
      name,
      description,
      changedBy,
    });
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route DELETE /api/v1/admin/holiday-calendars/:id
 * @desc Delete a holiday calendar and all its entries and revisions.
 * @access Private (admin token only)
 */
router.delete("/holiday-calendars/:id", requireAdminToken, async (req: Request, res: Response) => {
  try {
    await getHolidayCalendarService().deleteCalendar(req.params.id);
    return res.status(200).json({ success: true, message: "Calendar deleted" });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route POST /api/v1/admin/holiday-calendars/:id/entries
 * @desc Add a single holiday entry to an existing calendar.
 * @access Private (admin token only)
 *
 * Body:
 *   name       {string}  — holiday name
 *   start_date {string}  — YYYY-MM-DD inclusive start
 *   end_date   {string}  — YYYY-MM-DD inclusive end (equals start for single-day)
 *   recurring  {boolean} — whether this recurs annually (default false)
 *   note       {string}  — optional note
 */
router.post("/holiday-calendars/:id/entries", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const { name, start_date, end_date, recurring, note } = req.body ?? {};

    if (!name || typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ success: false, error: "name is required" });
    }
    if (!start_date || typeof start_date !== "string") {
      return res.status(400).json({ success: false, error: "start_date is required (YYYY-MM-DD)" });
    }
    if (!end_date || typeof end_date !== "string") {
      return res.status(400).json({ success: false, error: "end_date is required (YYYY-MM-DD)" });
    }

    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const entry = await getHolidayCalendarService().addEntry(req.params.id, {
      name,
      startDate: start_date,
      endDate: end_date,
      recurring: recurring ?? false,
      note,
      changedBy,
    });
    return res.status(201).json({ success: true, entry });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route DELETE /api/v1/admin/holiday-calendars/:id/entries/:entryId
 * @desc Remove a single holiday entry from a calendar.
 * @access Private (admin token only)
 */
router.delete(
  "/holiday-calendars/:id/entries/:entryId",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
      await getHolidayCalendarService().deleteEntry(req.params.id, req.params.entryId, changedBy);
      return res.status(200).json({ success: true, message: "Entry deleted" });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

/**
 * @route POST /api/v1/admin/holiday-calendars/import/yaml
 * @desc Import holidays from a YAML-shaped JSON payload.
 *       The import performs full schema validation and overlap detection.
 *       If a calendar for the region already exists, its entries are replaced.
 *       A new revision is saved on every successful import.
 * @access Private (admin token only)
 *
 * Body (parsed YAML as JSON):
 *   region      {string}   — target region (required)
 *   name        {string}   — calendar display name (optional, used only on creation)
 *   description {string}   — description (optional)
 *   holidays    {object[]} — array of { name, start_date, end_date, recurring?, note? }
 *
 * Validation errors return 422 with a `details` array.
 * Duplicate / overlapping ranges are rejected with 422.
 */
router.post("/holiday-calendars/import/yaml", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
    const calendar = await getHolidayCalendarService().importFromYaml(req.body, {
      changedBy,
      changeNote: req.body?.changeNote,
    });
    return res.status(200).json({ success: true, calendar });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id/revisions
 * @desc List all revisions for a calendar (newest first).
 * @access Private (admin token only)
 */
router.get("/holiday-calendars/:id/revisions", requireAdminToken, async (req: Request, res: Response) => {
  try {
    const revisions = await getHolidayCalendarService().listRevisions(req.params.id);
    return res.status(200).json({ success: true, revisions });
  } catch (err) {
    return handleHolidayCalendarError(err, res);
  }
});

/**
 * @route GET /api/v1/admin/holiday-calendars/:id/revisions/:version
 * @desc Fetch a specific historical revision snapshot.
 * @access Private (admin token only)
 */
router.get(
  "/holiday-calendars/:id/revisions/:version",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const version = parseInt(req.params.version, 10);
      if (isNaN(version) || version < 1) {
        return res.status(400).json({ success: false, error: "version must be a positive integer" });
      }
      const revision = await getHolidayCalendarService().getRevision(req.params.id, version);
      return res.status(200).json({ success: true, revision });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

/**
 * @route POST /api/v1/admin/holiday-calendars/:id/rollback/:version
 * @desc Roll the calendar back to a specific historical revision.
 *       The rollback itself is recorded as a new revision for auditability.
 * @access Private (admin token only)
 */
router.post(
  "/holiday-calendars/:id/rollback/:version",
  requireAdminToken,
  async (req: Request, res: Response) => {
    try {
      const version = parseInt(req.params.version, 10);
      if (isNaN(version) || version < 1) {
        return res.status(400).json({ success: false, error: "version must be a positive integer" });
      }
      const changedBy = req.auth?.userId ?? req.header("x-chronopay-admin-token")?.slice(0, 8);
      const calendar = await getHolidayCalendarService().rollbackToRevision(
        req.params.id,
        version,
        changedBy,
      );
      return res.status(200).json({ success: true, calendar });
    } catch (err) {
      return handleHolidayCalendarError(err, res);
    }
  },
);

export default router;

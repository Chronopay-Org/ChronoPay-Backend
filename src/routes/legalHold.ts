import { Router } from "express";
import { LegalHoldService } from "../services/legalHoldService.js";
import { defaultAuditLogger } from "../services/auditLogger.js";

export const legalHoldRouter = Router();

legalHoldRouter.post("/legal-holds", async (req, res) => {
  try {
    const { subjectId, actor, reason, region } = req.body;
    await LegalHoldService.addHold(subjectId, actor, reason, region);
    await defaultAuditLogger.log({ action: 'legal_hold.added', status: 'success', resource: `subject:${subjectId}`, metadata: { actor, reason, region } });
    res.status(201).json({ success: true });
  } catch {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

legalHoldRouter.get("/legal-holds/:subjectId", async (req, res) => {
  try {
    const isHeld = await LegalHoldService.isHeld(req.params.subjectId);
    res.json({ isHeld });
  } catch {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

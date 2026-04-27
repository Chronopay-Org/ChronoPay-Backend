import { Router, Request, Response } from "express";
import { SmsNotificationService, InMemorySmsProvider } from "../services/smsNotification.js";
import { validateRequiredFields } from "../middleware/validation.js";

const router = Router();
const smsService = new SmsNotificationService(new InMemorySmsProvider());

router.post(
  "/sms",
  validateRequiredFields(["to", "message"]),
  async (req: Request, res: Response) => {
    const { to, message } = req.body;
    const result = await smsService.send(to, message);
    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error });
    }
    return res.status(200).json({ success: true, provider: result.provider, providerMessageId: result.providerMessageId });
  },
);

export default router;

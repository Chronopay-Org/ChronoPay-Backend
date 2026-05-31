import { KycProvider, KycWebhookPayload } from "./kycProvider.js";

export class MockKycProvider implements KycProvider {
  name = "MockKycProvider";

  parseWebhook(body: any): KycWebhookPayload {
    if (!body || !body.supplierId || !body.kycRef || !body.status) {
      throw new Error("Missing required fields");
    }

    const status = body.status;
    const allowedStatuses = ["pending", "verified", "rejected", "under_review"];
    if (!allowedStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    return {
      supplierId: String(body.supplierId),
      kycRef: String(body.kycRef),
      status: status as KycWebhookPayload["status"],
    };
  }
}

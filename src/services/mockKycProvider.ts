import { KycProvider, KycWebhookPayload, KycInvalidPayloadError } from "./kycProvider.js";

const ALLOWED_STATUSES = ["pending", "verified", "rejected", "under_review"] as const;

// Matches the `kyc_ref VARCHAR(255)` column added in migration 007.
const KYC_REF_MAX_LENGTH = 255;

export class MockKycProvider implements KycProvider {
  name = "MockKycProvider";

  parseWebhook(body: any): KycWebhookPayload {
    if (!body || typeof body !== "object") {
      throw new KycInvalidPayloadError("Missing required fields");
    }

    if (!body.supplierId || !body.kycRef || !body.status) {
      throw new KycInvalidPayloadError("Missing required fields");
    }

    if (typeof body.kycRef !== "string" || body.kycRef.trim().length === 0) {
      throw new KycInvalidPayloadError("kycRef must be a non-empty string");
    }

    const kycRef = body.kycRef.trim();
    if (kycRef.length > KYC_REF_MAX_LENGTH) {
      throw new KycInvalidPayloadError(`kycRef must be ${KYC_REF_MAX_LENGTH} characters or fewer`);
    }

    const status = String(body.status);
    if (!(ALLOWED_STATUSES as readonly string[]).includes(status)) {
      throw new KycInvalidPayloadError(`Invalid status: ${status}`);
    }

    return {
      supplierId: String(body.supplierId),
      kycRef,
      status: status as KycWebhookPayload["status"],
    };
  }
}

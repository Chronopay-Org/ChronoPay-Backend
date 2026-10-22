export interface KycWebhookPayload {
  supplierId: string;
  kycRef: string;
  status: "pending" | "verified" | "rejected" | "under_review";
}

export interface KycProvider {
  name: string;
  parseWebhook(body: any): KycWebhookPayload;
}

/**
 * Raised by a KycProvider when the raw webhook body is not a well-formed KYC
 * event (missing fields, unknown status, out-of-bounds values). Maps to an
 * HTTP 400 so the caller can fix the payload instead of retrying blindly.
 */
export class KycInvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycInvalidPayloadError";
  }
}

/**
 * Raised when a KYC verification event references a supplier that no longer
 * exists. Maps to an HTTP 404 — a terminal condition, so providers should not
 * retry delivery.
 */
export class KycSupplierNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycSupplierNotFoundError";
  }
}

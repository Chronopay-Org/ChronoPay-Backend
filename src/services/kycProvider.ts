export interface KycWebhookPayload {
  supplierId: string;
  kycRef: string;
  status: "pending" | "verified" | "rejected" | "under_review";
}

export interface KycProvider {
  name: string;
  parseWebhook(body: any): KycWebhookPayload;
}

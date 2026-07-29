import { query } from "../db/pool.js";
import { KycWebhookPayload } from "./kycProvider.js";
import { reputationBootstrapService } from "./reputationBootstrapService.js";

export interface SupplierKycInfo {
  id: string;
  email: string;
  kycStatus: string;
  kycRef: string | null;
  region?: string | null;
}

export class KycService {
  private bootstrap: typeof reputationBootstrapService;

  constructor(bootstrapOverride?: typeof reputationBootstrapService) {
    this.bootstrap = bootstrapOverride ?? reputationBootstrapService;
  }

  async getSupplierKyc(supplierId: string): Promise<SupplierKycInfo | null> {
    const result = await query(
      "SELECT id, email, kyc_status, kyc_ref, region FROM users WHERE id = $1",
      [supplierId]
    );
    if (!result || (result.rowCount ?? 0) === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      email: row.email,
      kycStatus: row.kyc_status,
      kycRef: row.kyc_ref,
      region: row.region ?? null,
    };
  }

  async updateKycStatus(
    supplierId: string,
    status: KycWebhookPayload["status"],
    kycRef: string | null
  ): Promise<boolean> {
    const result = await query(
      "UPDATE users SET kyc_status = $1, kyc_ref = $2, updated_at = NOW() WHERE id = $3",
      [status, kycRef, supplierId]
    );
    return ((result?.rowCount ?? 0) > 0);
  }

  async processWebhook(payload: KycWebhookPayload): Promise<boolean> {
    const supplier = await this.getSupplierKyc(payload.supplierId);
    if (!supplier) {
      throw new Error(`Supplier with ID ${payload.supplierId} not found.`);
    }

    const prevStatus = supplier.kycStatus;
    const updated = await this.updateKycStatus(payload.supplierId, payload.status, payload.kycRef);

    if (!updated) return false;

    if (payload.status === "verified" && prevStatus !== "verified") {
      this.bootstrap.grant({
        supplierId: payload.supplierId,
        email: supplier.email,
        kycStatus: payload.status,
        kycRef: payload.kycRef,
        region: supplier.region,
      });
    }

    if (prevStatus === "verified" && payload.status !== "verified") {
      this.bootstrap.revoke(payload.supplierId, "KYC_STATUS_REVOKED");
    }

    return true;
  }
}

export const kycService = new KycService();

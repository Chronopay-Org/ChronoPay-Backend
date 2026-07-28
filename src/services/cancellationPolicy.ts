import { BookingIntentRecord } from "../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentError } from "../modules/booking-intents/booking-intent-service.js";

export interface RefundBreakdown {
  fee: number;
  taxReversal: number;
  netRefund: number;
  policyVersion: string;
}

export class CancellationPolicyService {
  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  calculateRefund(intent: BookingIntentRecord): RefundBreakdown {
    if (intent.status === "cancelled") {
      throw new BookingIntentError(409, "Already cancelled");
    }

    const price = intent.pricingSnapshot?.resolvedPrice ?? 0;
    
    // Timezone-sensitive tier logic
    const msUntilStart = intent.startTime - this.nowMs();
    const hoursUntilStart = msUntilStart / (1000 * 60 * 60);

    let refundRatio = 0;
    if (hoursUntilStart >= 24) {
      refundRatio = 1.0;
    } else if (hoursUntilStart >= 12) {
      refundRatio = 0.5;
    } else {
      refundRatio = 0.0;
    }

    const baseRefund = Math.round(price * refundRatio);
    // Reverse tax (10% of base refund)
    const taxReversal = Math.round(baseRefund * 0.1);
    // Apply fee (5% of base refund)
    const fee = Math.round(baseRefund * 0.05);
    const netRefund = baseRefund + taxReversal - fee;

    return {
      fee,
      taxReversal,
      netRefund,
      policyVersion: "v1-timezone-tier",
    };
  }
}

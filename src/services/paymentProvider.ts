import { randomBytes } from "node:crypto";
import type { CheckoutSession } from "../types/checkout.js";

export type PaymentResult =
  | { status: "succeeded"; providerRef: string }
  | { status: "declined"; providerRef: string; reason: string };

export interface PaymentProvider {
  charge(session: CheckoutSession): Promise<PaymentResult>;
}

export class MockPaymentProvider implements PaymentProvider {
  async charge(_session: CheckoutSession): Promise<PaymentResult> {
    if (randomBytes(1)[0] / 255 > 0.1) {
      return {
        status: "succeeded",
        providerRef: `mock_payment_${randomBytes(16).toString("hex")}`,
      };
    }

    return {
      status: "declined",
      providerRef: `mock_declined_${randomBytes(16).toString("hex")}`,
      reason: "Payment provider declined transaction",
    };
  }
}

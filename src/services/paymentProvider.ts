import { randomBytes } from "node:crypto";
import type { CheckoutSession } from "../types/checkout.js";

export type PaymentResult =
  | { status: "succeeded"; providerRef: string }
  | { status: "declined"; providerRef: string; reason: string };

export interface PaymentProvider {
  charge(session: CheckoutSession): Promise<PaymentResult>;
}

/**
 * Deterministic mock provider for use in non-production environments.
 *
 * By default every charge succeeds with a random provider reference.
 * Pass `outcome: "declined"` to the constructor to force all charges
 * to decline — useful for writing deterministic tests without mocking
 * `Math.random` or `crypto.randomBytes`.
 *
 * Throws at construction time when `NODE_ENV === "production"` so it
 * is impossible to accidentally wire this into a live environment.
 */
export class MockPaymentProvider implements PaymentProvider {
  private readonly outcome: "succeeded" | "declined";
  private readonly declineReason: string;

  constructor(
    outcome: "succeeded" | "declined" = "succeeded",
    declineReason = "Payment provider declined transaction",
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Mock payment provider cannot be used in production");
    }
    this.outcome = outcome;
    this.declineReason = declineReason;
  }

  async charge(_session: CheckoutSession): Promise<PaymentResult> {
    if (this.outcome === "succeeded") {
      return {
        status: "succeeded",
        providerRef: `mock_payment_${randomBytes(16).toString("hex")}`,
      };
    }

    return {
      status: "declined",
      providerRef: `mock_declined_${randomBytes(16).toString("hex")}`,
      reason: this.declineReason,
    };
  }
}

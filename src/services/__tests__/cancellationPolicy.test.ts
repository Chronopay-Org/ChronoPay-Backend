import { CancellationPolicyService } from "../cancellationPolicy.js";
import { BookingIntentRecord } from "../../modules/booking-intents/booking-intent-repository.js";
import { BookingIntentError } from "../../modules/booking-intents/booking-intent-service.js";

describe("CancellationPolicyService", () => {
  it("should calculate 100% refund when >= 24 hours until start", () => {
    const service = new CancellationPolicyService(() => 1000);
    const intent = {
      status: "pending",
      startTime: 1000 + 25 * 60 * 60 * 1000,
      pricingSnapshot: { resolvedPrice: 10000 },
    } as unknown as BookingIntentRecord;

    const refund = service.calculateRefund(intent);
    expect(refund.policyVersion).toBe("v1-timezone-tier");
    expect(refund.netRefund).toBe(10000 + 1000 - 500); // 10000 + 10% - 5%
    expect(refund.fee).toBe(500);
    expect(refund.taxReversal).toBe(1000);
  });

  it("should calculate 50% refund when between 12 and 24 hours", () => {
    const service = new CancellationPolicyService(() => 1000);
    const intent = {
      status: "pending",
      startTime: 1000 + 15 * 60 * 60 * 1000,
      pricingSnapshot: { resolvedPrice: 10000 },
    } as unknown as BookingIntentRecord;

    const refund = service.calculateRefund(intent);
    expect(refund.netRefund).toBe(5000 + 500 - 250); // 5000 + 10% - 5%
    expect(refund.fee).toBe(250);
    expect(refund.taxReversal).toBe(500);
  });

  it("should calculate 0% refund when < 12 hours", () => {
    const service = new CancellationPolicyService(() => 1000);
    const intent = {
      status: "pending",
      startTime: 1000 + 10 * 60 * 60 * 1000,
      pricingSnapshot: { resolvedPrice: 10000 },
    } as unknown as BookingIntentRecord;

    const refund = service.calculateRefund(intent);
    expect(refund.netRefund).toBe(0);
    expect(refund.fee).toBe(0);
    expect(refund.taxReversal).toBe(0);
  });

  it("should throw error if already cancelled", () => {
    const service = new CancellationPolicyService(() => 1000);
    const intent = {
      status: "cancelled",
      startTime: 1000 + 25 * 60 * 60 * 1000,
      pricingSnapshot: { resolvedPrice: 10000 },
    } as unknown as BookingIntentRecord;

    expect(() => service.calculateRefund(intent)).toThrow(BookingIntentError);
  });

  it("price change mid-preview (uses snapshot price)", () => {
    const service = new CancellationPolicyService(() => 1000);
    const intent = {
      status: "pending",
      startTime: 1000 + 25 * 60 * 60 * 1000,
      pricingSnapshot: { resolvedPrice: 20000 },
    } as unknown as BookingIntentRecord;

    const refund = service.calculateRefund(intent);
    expect(refund.netRefund).toBe(20000 + 2000 - 1000); 
  });
});

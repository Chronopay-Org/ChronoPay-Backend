export type RefundEntryStatus = "pending" | "completed" | "failed";

export interface RefundEntry {
  id: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  reason?: string;
  status: RefundEntryStatus;
  refundedBy?: string;
  createdAt: number;
}

export interface CreateRefundRequest {
  paymentId: string;
  amountCents: number;
  currency?: string;
  reason?: string;
  refundedBy?: string;
}

export interface PaymentTrace {
  payment: {
    id: string;
    amountCents: number;
    currency: string;
    status: string;
    createdAt: number;
  };
  refunds: RefundEntry[];
  totalRefundedCents: number;
  remainingCents: number;
}
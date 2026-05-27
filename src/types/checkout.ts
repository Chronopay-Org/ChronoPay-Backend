/**
 * Checkout Session Types and Interfaces
 * 
 * Defines types for the checkout session API, including:
 * - Create checkout session request/response
 * - Session status and payment details
 * - Error types
 */

/**
 * Supported payment methods for checkout
 */
export type PaymentMethod = "credit_card" | "bank_transfer" | "crypto";

/**
 * Supported currencies for payments
 */
export type Currency = "USD" | "EUR" | "GBP" | "XLM";

/**
 * Checkout session status enumeration
 */
export enum CheckoutSessionStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
  EXPIRED = "expired",
  CANCELLED = "cancelled",
}

/**
 * Payment information for a checkout session
 */
export interface PaymentInfo {
  /** Amount in the smallest unit (cents for fiat, stroops for XLM) */
  amount: number;
  /** Currency code */
  currency: Currency;
  /** Preferred payment method */
  paymentMethod: PaymentMethod;
  /** Optional payment descriptor */
  description?: string;
  /** Stellar asset identifier (AssetCode:Issuer or 'native') */
  asset?: string;
}

/**
 * Customer information for checkout
 */
export interface CustomerInfo {
  /** Unique customer identifier (UUID or external ID) */
  customerId: string;
  /** Customer email address */
  email: string;
  /** Customer first name */
  firstName?: string;
  /** Customer last name */
  lastName?: string;
  /** Billing address */
  address?: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

/**
 * Request body for creating a checkout session
 */
export interface CreateCheckoutSessionRequest {
  /** Payment information */
  payment: PaymentInfo;
  /** Customer information */
  customer: CustomerInfo;
  /** Optional metadata for tracking */
  metadata?: Record<string, string | number | boolean>;
  /** Success redirect URL (optional) */
  successUrl?: string;
  /** Cancel redirect URL (optional) */
  cancelUrl?: string;
}

/**
 * Checkout session data
 */
export interface CheckoutSession {
  /** Unique session ID (UUID) */
  id: string;
  /** Payment information */
  payment: PaymentInfo;
  /** Customer information */
  customer: CustomerInfo;
  /** Current session status */
  status: CheckoutSessionStatus;
  /** Unix timestamp when session was created */
  createdAt: number;
  /** Unix timestamp when session expires */
  expiresAt: number;
  /** Optional metadata for tracking */
  metadata?: Record<string, string | number | boolean>;
  /** Optional success redirect URL */
  successUrl?: string;
  /** Optional cancel redirect URL */
  cancelUrl?: string;
  /** Optional payment confirmation token */
  paymentToken?: string;
  /** Timestamp of last update */
  updatedAt: number;
}

/**
 * Response for creating a checkout session
 */
export interface CreateCheckoutSessionResponse {
  /** Success flag */
  success: boolean;
  /** Created session data */
  session: CheckoutSession;
  /** Session checkout URL (for direct payment) */
  checkoutUrl?: string;
}

/**
 * Response for retrieving a checkout session
 */
export interface GetCheckoutSessionResponse {
  /** Success flag */
  success: boolean;
  /** Session data */
  session: CheckoutSession;
}

/**
 * Error response for checkout operations
 */
export interface CheckoutErrorResponse {
  /** Success flag (always false) */
  success: false;
  /** Error code for client handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Custom error class for checkout operations
 */
export class CheckoutError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

/**
 * Predefined checkout error codes
 */
export const CheckoutErrorCode = {
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_ASSET: "INVALID_ASSET",
  INVALID_CURRENCY: "INVALID_CURRENCY",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_PAYMENT_METHOD: "INVALID_PAYMENT_METHOD",
  INVALID_CUSTOMER_ID: "INVALID_CUSTOMER_ID",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_SESSION_STATE: "INVALID_SESSION_STATE",
  UNAUTHORIZED: "UNAUTHORIZED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

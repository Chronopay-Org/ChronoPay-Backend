/**
 * Checkout Session Validation Middleware
 * 
 * Validates checkout session requests with comprehensive input validation:
 * - Email format validation
 * - Amount validation (positive, reasonable limits)
 * - Payment method validation
 * - Required fields validation
 * - Custom ID format validation
 */

import { Request, Response, NextFunction } from "express";
import {
  CheckoutError,
  CheckoutErrorCode,
  Currency,
  PaymentMethod,
} from "../types/checkout.js";

import { AmountUtils } from "../utils/amount.js";

/**
 * Validates email format
 * @param email - Email address to validate
 * @returns true if email is valid
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

/**
 * Validates payment amount
 * @param amount - Amount in smallest unit
 * @returns true if amount is valid integer
 */
export function isValidAmount(amount: unknown): boolean {
  return AmountUtils.validate(amount);
}

/**
 * Validates Stellar asset identifier
 * @param asset - Asset identifier (AssetCode:Issuer or 'native')
 * @returns true if asset identifier is valid
 */
export function isValidAsset(asset: unknown): boolean {
  if (typeof asset !== "string") return false;
  if (asset === "native") return true;

  // Asset format: AssetCode:IssuerAddress
  // AssetCode: 1-12 alphanumeric characters
  // IssuerAddress: 56 characters (Stellar public key format: starting with G)
  const assetParts = asset.split(":");
  if (assetParts.length !== 2) return false;

  const [code, issuer] = assetParts;
  
  const codeRegex = /^[a-zA-Z0-9]{1,12}$/;
  const issuerRegex = /^G[A-Z2-7]{55}$/;

  return codeRegex.test(code) && issuerRegex.test(issuer);
}

/**
 * Validates currency code
 * @param currency - Currency to validate
 * @returns true if currency is supported
 */
export function isValidCurrency(currency: unknown): boolean {
  const validCurrencies: Currency[] = ["USD", "EUR", "GBP", "XLM"];
  return validCurrencies.includes(currency as Currency);
}

/**
 * Validates payment method
 * @param method - Payment method to validate
 * @returns true if payment method is supported
 */
export function isValidPaymentMethod(method: unknown): boolean {
  const validMethods: PaymentMethod[] = [
    "credit_card",
    "bank_transfer",
    "crypto",
  ];
  return validMethods.includes(method as PaymentMethod);
}

/**
 * Validates customer ID format (UUID or alphanumeric)
 * @param customerId - Customer ID to validate
 * @returns true if customer ID format is valid
 */
export function isValidCustomerId(customerId: unknown): boolean {
  if (typeof customerId !== "string") return false;
  if (customerId.length === 0 || customerId.length > 255) return false;
  // Allow UUID format or alphanumeric with underscores/hyphens
  const idRegex = /^[a-zA-Z0-9_-]+$/;
  return idRegex.test(customerId);
}

/**
 * Middleware to validate checkout session creation request
 * Validates all required and optional fields
 * 
 * @returns Express middleware function
 */
export function validateCreateCheckoutSession() {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const { payment, customer } = req.body;

      // Validate payment object exists
      if (!payment || typeof payment !== "object") {
        throw new CheckoutError(
          CheckoutErrorCode.MISSING_REQUIRED_FIELD,
          "Missing or invalid payment information",
          400,
          { field: "payment" },
        );
      }

      // Validate amount
      if (!isValidAmount(payment.amount)) {
        throw new CheckoutError(
          CheckoutErrorCode.INVALID_AMOUNT,
          "Amount must be a strictly positive integer representing minor units",
          400,
          { field: "payment.amount", provided: payment.amount },
        );
      }

      // Validate asset if provided (required for crypto payment method)
      if (payment.paymentMethod === "crypto" || payment.asset) {
        if (!isValidAsset(payment.asset)) {
          throw new CheckoutError(
            CheckoutErrorCode.INVALID_ASSET,
            "Invalid Stellar asset identifier. Must be 'native' or 'AssetCode:Issuer'",
            400,
            { field: "payment.asset", provided: payment.asset },
          );
        }
      }

      // Validate currency
      if (!isValidCurrency(payment.currency)) {
        throw new CheckoutError(
          CheckoutErrorCode.INVALID_CURRENCY,
          "Unsupported currency. Supported: USD, EUR, GBP, XLM",
          400,
          { field: "payment.currency", provided: payment.currency },
        );
      }

      // Validate payment method
      if (!isValidPaymentMethod(payment.paymentMethod)) {
        throw new CheckoutError(
          CheckoutErrorCode.INVALID_PAYMENT_METHOD,
          "Invalid payment method. Supported: credit_card, bank_transfer, crypto",
          400,
          { field: "payment.paymentMethod", provided: payment.paymentMethod },
        );
      }

      // Validate customer object exists
      if (!customer || typeof customer !== "object") {
        throw new CheckoutError(
          CheckoutErrorCode.MISSING_REQUIRED_FIELD,
          "Missing or invalid customer information",
          400,
          { field: "customer" },
        );
      }

      // Validate customer ID
      if (!isValidCustomerId(customer.customerId)) {
        throw new CheckoutError(
          CheckoutErrorCode.INVALID_CUSTOMER_ID,
          "Invalid customer ID format",
          400,
          { field: "customer.customerId", provided: customer.customerId },
        );
      }

      // Validate email
      if (!isValidEmail(customer.email)) {
        throw new CheckoutError(
          CheckoutErrorCode.INVALID_EMAIL,
          "Invalid email format",
          400,
          { field: "customer.email", provided: customer.email },
        );
      }

      // Validate optional metadata if provided
      if (
        req.body.metadata !== undefined &&
        (typeof req.body.metadata !== "object" || Array.isArray(req.body.metadata))
      ) {
        throw new CheckoutError(
          CheckoutErrorCode.MISSING_REQUIRED_FIELD,
          "Metadata must be an object",
          400,
          { field: "metadata" },
        );
      }

      next();
    } catch (error) {
      if (error instanceof CheckoutError) {
        return res.status(error.status).json({
          success: false,
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }

      return res.status(500).json({
        success: false,
        code: CheckoutErrorCode.INTERNAL_ERROR,
        message: "Internal validation error",
      });
    }
  };
}

/**
 * Middleware to validate checkout session ID parameter
 * Ensures session ID is in valid format
 * 
 * @returns Express middleware function
 */
export function validateSessionIdParam() {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      if (!sessionId || typeof sessionId !== "string") {
        throw new CheckoutError(
          CheckoutErrorCode.MISSING_REQUIRED_FIELD,
          "Missing session ID",
          400,
        );
      }

      // Basic UUID format validation (36 chars with hyphens)
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sessionId)) {
        throw new CheckoutError(
          CheckoutErrorCode.MISSING_REQUIRED_FIELD,
          "Invalid session ID format",
          400,
          { field: "sessionId" },
        );
      }

      next();
    } catch (error) {
      if (error instanceof CheckoutError) {
        return res.status(error.status).json({
          success: false,
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }

      return res.status(500).json({
        success: false,
        code: CheckoutErrorCode.INTERNAL_ERROR,
        message: "Internal validation error",
      });
    }
  };
}

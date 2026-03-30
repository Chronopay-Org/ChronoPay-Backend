/**
 * Checkout Session API Routes
 * 
 * RESTful endpoints for checkout session management:
 * - POST /api/v1/checkout/sessions - Create new session
 * - GET /api/v1/checkout/sessions/:sessionId - Retrieve session
 * - POST /api/v1/checkout/sessions/:sessionId/complete - Mark as completed
 * - POST /api/v1/checkout/sessions/:sessionId/cancel - Cancel session
 */

import { Router, Request, Response } from "express";
import { CheckoutSessionService } from "../services/checkout.js";
import {
  validateCreateCheckoutSession,
  validateSessionIdParam,
} from "../middleware/checkout-validation.js";
import {
  CheckoutError,
  CheckoutErrorCode,
  CreateCheckoutSessionResponse,
  GetCheckoutSessionResponse,
  CheckoutErrorResponse,
} from "../types/checkout.js";

const checkoutRouter = Router();

/**
 * POST /api/v1/checkout/sessions
 * 
 * Creates a new checkout session
 * 
 * Request:
 *   - payment.amount: number (positive integer, smallest currency unit)
 *   - payment.currency: "USD" | "EUR" | "GBP" | "XLM"
 *   - payment.paymentMethod: "credit_card" | "bank_transfer" | "crypto"
 *   - customer.customerId: string (UUID or alphanumeric)
 *   - customer.email: string (valid email)
 *   - metadata?: object (optional tracking data)
 *   - successUrl?: string (optional redirect on success)
 *   - cancelUrl?: string (optional redirect on cancel)
 * 
 * Response (201):
 *   - success: true
 *   - session: CheckoutSession with id, status, timestamps
 *   - checkoutUrl?: string (URL for direct payment)
 * 
 * Error Responses:
 *   - 400: Invalid input (amount, currency, email, etc.)
 *   - 401: Unauthorized (if AUTH required)
 *   - 503: Session limit reached
 *   - 500: Internal server error
 */
checkoutRouter.post(
  "/sessions",
  validateCreateCheckoutSession(),
  (req: Request, res: Response) => {
    try {
      const authToken = req.headers.authorization?.replace("Bearer ", "");
      const session = CheckoutSessionService.createSession(req.body, authToken);

      const response: CreateCheckoutSessionResponse = {
        success: true,
        session,
        checkoutUrl: `${process.env.BASE_URL || "http://localhost:3001"}/api/v1/checkout/sessions/${session.id}/pay`,
      };

      res.status(201).json(response);
    } catch (error) {
      handleCheckoutError(error, res);
    }
  },
);

/**
 * GET /api/v1/checkout/sessions/:sessionId
 * 
 * Retrieves a checkout session by ID
 * 
 * Parameters:
 *   - sessionId: string (UUID format)
 * 
 * Response (200):
 *   - success: true
 *   - session: CheckoutSession with current status
 * 
 * Error Responses:
 *   - 400: Invalid session ID format
 *   - 404: Session not found
 *   - 410: Session expired
 *   - 500: Internal server error
 */
checkoutRouter.get(
  "/sessions/:sessionId",
  validateSessionIdParam(),
  (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const session = CheckoutSessionService.getSession(sessionId);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      handleCheckoutError(error, res);
    }
  },
);

/**
 * POST /api/v1/checkout/sessions/:sessionId/complete
 * 
 * Marks a checkout session as completed (payment successful)
 * 
 * Parameters:
 *   - sessionId: string (UUID format)
 * 
 * Request (optional):
 *   - paymentToken?: string (confirmation token from payment processor)
 * 
 * Response (200):
 *   - success: true
 *   - session: CheckoutSession with COMPLETED status
 * 
 * Error Responses:
 *   - 400: Invalid session ID format
 *   - 404: Session not found
 *   - 409: Session in invalid state (already completed/failed/cancelled)
 *   - 410: Session expired
 *   - 500: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/complete",
  validateSessionIdParam(),
  (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { paymentToken } = req.body;

      const session = CheckoutSessionService.completeSession(
        sessionId,
        paymentToken,
      );

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      handleCheckoutError(error, res);
    }
  },
);

/**
 * POST /api/v1/checkout/sessions/:sessionId/fail
 * 
 * Marks a checkout session as failed (payment failed)
 * 
 * Parameters:
 *   - sessionId: string (UUID format)
 * 
 * Request (optional):
 *   - reason?: string (reason for failure)
 * 
 * Response (200):
 *   - success: true
 *   - session: CheckoutSession with FAILED status
 * 
 * Error Responses:
 *   - 400: Invalid session ID format
 *   - 404: Session not found
 *   - 409: Session in invalid state
 *   - 410: Session expired
 *   - 500: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/fail",
  validateSessionIdParam(),
  (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { reason } = req.body;

      const session = CheckoutSessionService.failSession(sessionId, reason);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      handleCheckoutError(error, res);
    }
  },
);

/**
 * POST /api/v1/checkout/sessions/:sessionId/cancel
 * 
 * Cancels a checkout session
 * 
 * Parameters:
 *   - sessionId: string (UUID format)
 * 
 * Response (200):
 *   - success: true
 *   - session: CheckoutSession with CANCELLED status
 * 
 * Error Responses:
 *   - 400: Invalid session ID format
 *   - 404: Session not found
 *   - 409: Session in invalid state (already completed/failed/cancelled)
 *   - 410: Session expired
 *   - 500: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/cancel",
  validateSessionIdParam(),
  (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const session = CheckoutSessionService.cancelSession(sessionId);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      handleCheckoutError(error, res);
    }
  },
);

/**
 * Error handler for checkout operations
 * Converts CheckoutError to appropriate HTTP response
 * 
 * @param error - Error object
 * @param res - Express response object
 */
function handleCheckoutError(error: unknown, res: Response): void {
  if (error instanceof CheckoutError) {
    const statusCode = error.status || 400;
    const response: CheckoutErrorResponse = {
      success: false,
      code: error.code,
      message: error.message,
      details: error.details,
    };
    res.status(statusCode).json(response);
  } else if (error instanceof Error) {
    // Unexpected error
    const response: CheckoutErrorResponse = {
      success: false,
      code: CheckoutErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    };
    res.status(500).json(response);
  } else {
    // Unknown error type
    const response: CheckoutErrorResponse = {
      success: false,
      code: CheckoutErrorCode.INTERNAL_ERROR,
      message: "Unknown error",
    };
    res.status(500).json(response);
  }
}

export default checkoutRouter;

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
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  CheckoutError,
  CheckoutErrorCode,
  CreateCheckoutSessionResponse,
  GetCheckoutSessionResponse,
  CheckoutErrorResponse,
} from "../types/checkout.js";

const checkoutRouter = Router();

/**
 * @openapi
 * /api/v1/checkout/sessions:
 *   post:
 *     summary: Create a new checkout session
 *     description: >
 *       Creates a new checkout session for payment processing. Supports multiple
 *       payment methods and currencies. Optional JWT authentication for enhanced
 *       tracking and user association.
 *     tags: [Checkout]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *       - [] # Optional authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payment, customer]
 *             properties:
 *               payment:
 *                 type: object
 *                 required: [amount, currency, paymentMethod]
 *                 properties:
 *                   amount:
 *                     type: integer
 *                     minimum: 1
 *                     description: Amount in smallest currency unit (e.g., cents)
 *                   currency:
 *                     type: string
 *                     enum: [USD, EUR, GBP, XLM]
 *                   paymentMethod:
 *                     type: string
 *                     enum: [credit_card, bank_transfer, crypto]
 *               customer:
 *                 type: object
 *                 required: [customerId, email]
 *                 properties:
 *                   customerId:
 *                     type: string
 *                     pattern: '^[a-zA-Z0-9-]+$'
 *                     description: UUID or alphanumeric customer identifier
 *                   email:
 *                     type: string
 *                     format: email
 *               metadata:
 *                 type: object
 *                 description: Optional tracking data
 *               successUrl:
 *                 type: string
 *                 format: uri
 *                 description: Optional redirect URL on successful payment
 *               cancelUrl:
 *                 type: string
 *                 format: uri
 *                 description: Optional redirect URL on cancelled payment
 *     responses:
 *       201:
 *         description: Checkout session created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 session:
 *                   type: object
 *                   description: Checkout session details
 *                 checkoutUrl:
 *                   type: string
 *                   format: uri
 *                   description: Direct payment URL
 *       400:
 *         description: Invalid input data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       503:
 *         description: Session limit reached
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 */
checkoutRouter.post(
  "/sessions",
  validateCreateCheckoutSession(),
  idempotencyMiddleware,
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
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}:
 *   get:
 *     summary: Retrieve a checkout session
 *     description: >
 *       Retrieves a checkout session by ID. Returns current status and all
 *       session details. No authentication required for basic session lookup.
 *     tags: [Checkout]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *       - [] # Optional authentication
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID (UUID format)
 *     responses:
 *       200:
 *         description: Session retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 session:
 *                   type: object
 *                   description: Checkout session details
 *       400:
 *         description: Invalid session ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       410:
 *         description: Session expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
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
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/complete:
 *   post:
 *     summary: Mark checkout session as completed
 *     description: >
 *       Marks a checkout session as completed (payment successful). Requires
 *       authentication to prevent unauthorized completion attempts.
 *     tags: [Checkout]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID (UUID format)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paymentToken:
 *                 type: string
 *                 description: Confirmation token from payment processor
 *     responses:
 *       200:
 *         description: Session marked as completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 session:
 *                   type: object
 *                   description: Updated checkout session with COMPLETED status
 *       400:
 *         description: Invalid session ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       409:
 *         description: Session in invalid state (already completed/failed/cancelled)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       410:
 *         description: Session expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
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
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/fail:
 *   post:
 *     summary: Mark checkout session as failed
 *     description: >
 *       Marks a checkout session as failed (payment failed). Requires authentication
 *       to prevent unauthorized status changes.
 *     tags: [Checkout]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID (UUID format)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for payment failure
 *     responses:
 *       200:
 *         description: Session marked as failed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 session:
 *                   type: object
 *                   description: Updated checkout session with FAILED status
 *       400:
 *         description: Invalid session ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       409:
 *         description: Session in invalid state
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       410:
 *         description: Session expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
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
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/cancel:
 *   post:
 *     summary: Cancel a checkout session
 *     description: >
 *       Cancels a checkout session. Can be called by the session owner or
 *       authenticated admin users.
 *     tags: [Checkout]
 *     security:
 *       - chronoPayAuth: []
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Session ID (UUID format)
 *     responses:
 *       200:
 *         description: Session cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 session:
 *                   type: object
 *                   description: Updated checkout session with CANCELLED status
 *       400:
 *         description: Invalid session ID format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       409:
 *         description: Session in invalid state (already completed/failed/cancelled)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       410:
 *         description: Session expired
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorEnvelope'
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

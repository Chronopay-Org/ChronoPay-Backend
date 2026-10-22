/**
 * Checkout Session API Routes
 *
 * RESTful endpoints for checkout session management:
 * - POST /api/v1/checkout/sessions - Create new session
 * - GET /api/v1/checkout/sessions/:sessionId - Retrieve session (owner or admin)
 * - POST /api/v1/checkout/sessions/:sessionId/complete - Mark as completed (HMAC or admin only)
 * - POST /api/v1/checkout/sessions/:sessionId/pay - Initiate payment (owner or admin)
 * - POST /api/v1/checkout/sessions/:sessionId/fail - Mark as failed (HMAC or admin only)
 * - POST /api/v1/checkout/sessions/:sessionId/cancel - Cancel session (owner or admin)
 */

import { Router, Request, Response, NextFunction } from "express";
import { CheckoutSessionService } from "../services/checkout.js";
import {
  validateCreateCheckoutSession,
  validateSessionIdParam,
} from "../middleware/checkout-validation.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import {
  CreateCheckoutSessionResponse,
  GetCheckoutSessionResponse,
  CheckoutError,
  CheckoutErrorCode,
} from "../types/checkout.js";
import { requireFeatureFlag } from "../middleware/featureFlags.js";
import { payloadLimit, ROUTE_PAYLOAD_LIMITS } from "../middleware/payloadLimit.js";
import {
  authenticateToken,
  authorizeOwnerOrAdmin,
} from "../middleware/auth.middleware.js";
import { internalHmacAuth } from "../middleware/internalHmacAuth.js";

const checkoutRouter = Router();

// Kill-switch: all checkout routes are guarded by FF_CHECKOUT.
checkoutRouter.use(requireFeatureFlag("CHECKOUT"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the secret to use for checkout provider callbacks.
 * Uses CHECKOUT_WEBHOOK_SECRET when set, otherwise falls back to
 * SETTLEMENTS_WEBHOOK_SECRET (shared signing key).
 */
function getCheckoutHmacSecret(): string | undefined {
  return process.env.CHECKOUT_WEBHOOK_SECRET ?? process.env.SETTLEMENTS_WEBHOOK_SECRET;
}

/**
 * Combined middleware: accepts either a valid HMAC-signed provider callback
 * OR a JWT-authenticated admin user.  Used on /complete and /fail, which
 * must not be callable by regular customers.
 *
 * Decision tree:
 *   1. If x-webhook-signature header is present → enforce HMAC (internalHmacAuth).
 *   2. Otherwise → enforce JWT (authenticateToken) and require role=admin.
 */
function hmacOrAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.headers["x-webhook-signature"]) {
    // Provider callback path — validate HMAC.
    internalHmacAuth(getCheckoutHmacSecret())(req, res, next);
  } else {
    // Human/admin path — validate JWT then enforce admin role.
    authenticateToken(req, res, (err) => {
      if (err) return next(err);

      const role = (req as any).user?.role;
      if (role !== "admin") {
        res.status(403).json({
          success: false,
          error: "Forbidden: requires admin role or valid HMAC signature",
        });
        return;
      }
      next();
    });
  }
}

/**
 * Inline ownership guard used after the session has already been fetched.
 * Returns false (and writes the response) if the caller is not the session
 * owner and not an admin; returns true when the caller is allowed to proceed.
 */
function assertOwnerOrAdmin(
  req: Request,
  res: Response,
  sessionCustomerId: string,
): boolean {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }

  if (user.role === "admin") {
    return true;
  }

  const callerId: string | undefined = user.sub ?? user.id;
  if (!callerId || callerId !== sessionCustomerId) {
    res.status(403).json({ success: false, error: "Access denied" });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * @openapi
 * /api/v1/checkout/sessions:
 *   post:
 *     summary: Create a new checkout session
 *     description: >
 *       Creates a new checkout session for payment processing. Supports multiple
 *       payment methods and currencies. Optional JWT authentication; when a token
 *       is present the token subject (sub) must match customer.customerId.
 *     tags: [Checkout]
 *     security:
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
 *                 maxLength: 2048
 *                 description: Optional absolute HTTPS redirect URL on an exact configured host; HTTP allowed only outside production. Invalid values return 400 INVALID_REDIRECT_URL with details.field.
 *               cancelUrl:
 *                 type: string
 *                 format: uri
 *                 maxLength: 2048
 *                 description: Optional cancel redirect, subject to the same configured host and scheme policy as successUrl.
 *     responses:
 *       201:
 *         description: Checkout session created successfully
 *       400:
 *         description: Invalid input data; redirect failures use the checkout envelope with code INVALID_REDIRECT_URL and details.field identifying successUrl or cancelUrl.
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
 *       500:
 *         description: Internal server error
 */
checkoutRouter.post(
  "/sessions",
  ...payloadLimit(ROUTE_PAYLOAD_LIMITS.checkout),
  validateCreateCheckoutSession(),
  idempotencyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authToken = req.headers.authorization?.replace("Bearer ", "");
      const session = await CheckoutSessionService.createSession(req.body, authToken);

      const response: CreateCheckoutSessionResponse = {
        success: true,
        session,
        checkoutUrl: `${process.env.BASE_URL || "http://localhost:3001"}/api/v1/checkout/sessions/${session.id}/pay`,
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}:
 *   get:
 *     summary: Retrieve a checkout session
 *     description: >
 *       Retrieves a checkout session by ID. Requires a valid JWT; only the
 *       session owner or an admin may read the session.
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session retrieved successfully
 *       400:
 *         description: Invalid session ID format
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *       410:
 *         description: Session expired
 *       500:
 *         description: Internal server error
 */
checkoutRouter.get(
  "/sessions/:sessionId",
  validateSessionIdParam(),
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const session = await CheckoutSessionService.getSession(sessionId);

      if (!assertOwnerOrAdmin(req, res, session.customer.customerId)) return;

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/complete:
 *   post:
 *     summary: Mark checkout session as completed
 *     description: >
 *       Marks a checkout session as completed (payment successful). Restricted
 *       to trusted payment-provider callbacks (HMAC-signed) or admin users.
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
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
 *       400:
 *         description: Invalid session ID format
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *       409:
 *         description: Session in invalid state
 *       410:
 *         description: Session expired
 *       500:
 *         description: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/complete",
  validateSessionIdParam(),
  hmacOrAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { paymentToken } = req.body;

      const session = await CheckoutSessionService.completeSession(sessionId, paymentToken);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/pay:
 *   post:
 *     summary: Initiate payment for a checkout session
 *     description: >
 *       Initiates payment processing for a checkout session. Requires a valid
 *       JWT; only the session owner or an admin may trigger payment.
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Payment processed successfully (COMPLETED or FAILED)
 *       400:
 *         description: Invalid session ID format
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *       409:
 *         description: Session in invalid state
 *       410:
 *         description: Session expired
 *       500:
 *         description: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/pay",
  validateSessionIdParam(),
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Fetch first to check ownership before touching state.
      const sessionForAuth = await CheckoutSessionService.getSession(sessionId);
      if (!assertOwnerOrAdmin(req, res, sessionForAuth.customer.customerId)) return;

      const session = await CheckoutSessionService.paySession(sessionId);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/fail:
 *   post:
 *     summary: Mark checkout session as failed
 *     description: >
 *       Marks a checkout session as failed (payment failed). Restricted to
 *       trusted payment-provider callbacks (HMAC-signed) or admin users.
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
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
 *       400:
 *         description: Invalid session ID format
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *       409:
 *         description: Session in invalid state
 *       410:
 *         description: Session expired
 *       500:
 *         description: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/fail",
  validateSessionIdParam(),
  hmacOrAdminAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;
      const { reason } = req.body;

      const session = await CheckoutSessionService.failSession(sessionId, reason);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * @openapi
 * /api/v1/checkout/sessions/{sessionId}/cancel:
 *   post:
 *     summary: Cancel a checkout session
 *     description: >
 *       Cancels a checkout session. Requires a valid JWT; only the session
 *       owner or an admin may cancel.
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *       - adminTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session cancelled successfully
 *       400:
 *         description: Invalid session ID format
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       404:
 *         description: Session not found
 *       409:
 *         description: Session in invalid state
 *       410:
 *         description: Session expired
 *       500:
 *         description: Internal server error
 */
checkoutRouter.post(
  "/sessions/:sessionId/cancel",
  validateSessionIdParam(),
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // Fetch first to check ownership before touching state.
      const sessionForAuth = await CheckoutSessionService.getSession(sessionId);
      if (!assertOwnerOrAdmin(req, res, sessionForAuth.customer.customerId)) return;

      const session = await CheckoutSessionService.cancelSession(sessionId);

      const response: GetCheckoutSessionResponse = {
        success: true,
        session,
      };

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

export default checkoutRouter;

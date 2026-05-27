/**
 * Buyer Profile Routes
 * 
 * Defines all HTTP routes for Buyer Profile operations.
 * Applies authentication, authorization, and validation middleware.
 */

import { Router } from "express";
import { buyerProfileController } from "./buyer-profile.controller.js";
import { authenticate, authorize, UserRole } from "../middleware/auth.middleware.js";
import { createAuthAwareRateLimiter } from "../middleware/rateLimiter.js";
import {
  validateCreateBuyerProfile,
  validateUpdateBuyerProfile,
  validateUUID,
} from "./dto/buyer-profile.dto.js";

const router = Router();

/**
 * @route   POST /api/v1/buyer-profiles
 * @desc    Create a new buyer profile
 * @access  Private (authenticated users only)
 */
router.post(
  "/",
  authenticate,
  createAuthAwareRateLimiter(),
  validateCreateBuyerProfile,
  buyerProfileController.create.bind(buyerProfileController)
);

/**
 * @route   GET /api/v1/buyer-profiles/me
 * @desc    Get current user's profile
 * @access  Private (authenticated users only)
 */
router.get(
  "/me",
  authenticate,
  createAuthAwareRateLimiter(),
  buyerProfileController.getMyProfile.bind(buyerProfileController)
);

/**
 * @route   GET /api/v1/buyer-profiles
 * @desc    List all buyer profiles (admin only)
 * @access  Private (admin only)
 */
router.get(
  "/",
  authenticate,
  authorize(UserRole.ADMIN),
  createAuthAwareRateLimiter(),
  buyerProfileController.list.bind(buyerProfileController)
);

/**
 * @route   GET /api/v1/buyer-profiles/:id
 * @desc    Get a buyer profile by ID
 * @access  Private (owner or admin)
 */
router.get(
  "/:id",
  authenticate,
  createAuthAwareRateLimiter(),
  validateUUID,
  buyerProfileController.getById.bind(buyerProfileController)
);

/**
 * @route   PATCH /api/v1/buyer-profiles/:id
 * @desc    Update a buyer profile
 * @access  Private (owner or admin)
 */
router.patch(
  "/:id",
  authenticate,
  createAuthAwareRateLimiter(),
  validateUUID,
  validateUpdateBuyerProfile,
  buyerProfileController.update.bind(buyerProfileController)
);

/**
 * @route   DELETE /api/v1/buyer-profiles/:id
 * @desc    Delete a buyer profile
 * @access  Private (owner or admin)
 */
router.delete(
  "/:id",
  authenticate,
  createAuthAwareRateLimiter(),
  validateUUID,
  buyerProfileController.delete.bind(buyerProfileController)
);

export default router;

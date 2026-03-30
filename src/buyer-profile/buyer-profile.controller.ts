/**
 * Buyer Profile Controller
 * 
 * Handles HTTP requests for Buyer Profile operations.
 * Implements RESTful API endpoints with proper error handling.
 */

import { Request, Response } from "express";
import { buyerProfileService } from "./buyer-profile.service.js";
import { BuyerProfileFilters, PaginationParams } from "./types/buyer-profile.types.js";

/**
 * Buyer Profile Controller Class
 */
export class BuyerProfileController {
  /**
   * POST /api/v1/buyer-profiles
   * Create a new buyer profile for the authenticated user
   */
  async create(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to create a profile",
        });
      }

      const { fullName, email, phoneNumber, address, avatarUrl } = req.body;

      const profile = await buyerProfileService.create({
        userId: req.user.id,
        fullName,
        email,
        phoneNumber,
        address,
        avatarUrl,
      });

      return res.status(201).json({
        success: true,
        data: profile,
        message: "Buyer profile created successfully",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create profile";

      if (message.includes("already has a buyer profile")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message,
        });
      }

      if (message.includes("Email is already in use")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message,
        });
      }

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while creating the profile",
      });
    }
  }

  /**
   * GET /api/v1/buyer-profiles/me
   * Get the current authenticated user's profile
   */
  async getMyProfile(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to view their profile",
        });
      }

      const profile = await buyerProfileService.getByUserId(req.user.id);

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "No profile found for the current user",
        });
      }

      return res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while fetching the profile",
      });
    }
  }

  /**
   * GET /api/v1/buyer-profiles/:id
   * Get a buyer profile by ID (admin only for other users' profiles)
   */
  async getById(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to view profiles",
        });
      }

      const { id } = req.params;

      const profile = await buyerProfileService.getById(id);

      if (!profile) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "Profile not found",
        });
      }

      // Check authorization: users can only view their own profile, admins can view any
      if (req.user.role !== "admin" && profile.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          message: "You can only view your own profile",
        });
      }

      return res.status(200).json({
        success: true,
        data: profile,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while fetching the profile",
      });
    }
  }

  /**
   * GET /api/v1/buyer-profiles
   * List buyer profiles with optional filters and pagination (admin only)
   */
  async list(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to list profiles",
        });
      }

      // Only admins can list all profiles
      if (req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          message: "Only administrators can list all profiles",
        });
      }

      // Parse query parameters
      const filters: BuyerProfileFilters = {};
      if (req.query.userId) filters.userId = req.query.userId as string;
      if (req.query.email) filters.email = req.query.email as string;
      if (req.query.fullName) filters.fullName = req.query.fullName as string;

      const pagination: PaginationParams = {};
      if (req.query.page) pagination.page = parseInt(req.query.page as string, 10);
      if (req.query.limit) pagination.limit = parseInt(req.query.limit as string, 10);

      const result = await buyerProfileService.list(filters, pagination);

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while listing profiles",
      });
    }
  }

  /**
   * PATCH /api/v1/buyer-profiles/:id
   * Update a buyer profile (owner only)
   */
  async update(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to update profiles",
        });
      }

      const { id } = req.params;

      // Check if profile exists
      const existingProfile = await buyerProfileService.getById(id);

      if (!existingProfile) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "Profile not found",
        });
      }

      // Check authorization: users can only update their own profile, admins can update any
      if (req.user.role !== "admin" && existingProfile.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          message: "You can only update your own profile",
        });
      }

      const { fullName, email, phoneNumber, address, avatarUrl } = req.body;

      const updatedProfile = await buyerProfileService.update(id, {
        fullName,
        email,
        phoneNumber,
        address,
        avatarUrl,
      });

      return res.status(200).json({
        success: true,
        data: updatedProfile,
        message: "Profile updated successfully",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update profile";

      if (message.includes("Profile not found")) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message,
        });
      }

      if (message.includes("Email is already in use")) {
        return res.status(409).json({
          success: false,
          error: "Conflict",
          message,
        });
      }

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while updating the profile",
      });
    }
  }

  /**
   * DELETE /api/v1/buyer-profiles/:id
   * Delete a buyer profile (owner or admin only)
   */
  async delete(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: "Authentication required",
          message: "User must be authenticated to delete profiles",
        });
      }

      const { id } = req.params;

      // Check if profile exists
      const existingProfile = await buyerProfileService.getById(id);

      if (!existingProfile) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message: "Profile not found",
        });
      }

      // Check authorization: users can only delete their own profile, admins can delete any
      if (req.user.role !== "admin" && existingProfile.userId !== req.user.id) {
        return res.status(403).json({
          success: false,
          error: "Access denied",
          message: "You can only delete your own profile",
        });
      }

      await buyerProfileService.delete(id);

      return res.status(200).json({
        success: true,
        message: "Profile deleted successfully",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete profile";

      if (message.includes("Profile not found")) {
        return res.status(404).json({
          success: false,
          error: "Not found",
          message,
        });
      }

      return res.status(500).json({
        success: false,
        error: "Internal server error",
        message: "An unexpected error occurred while deleting the profile",
      });
    }
  }
}

// Export singleton instance
export const buyerProfileController = new BuyerProfileController();

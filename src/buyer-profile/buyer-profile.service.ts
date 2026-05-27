/**
 * Buyer Profile Service
 * 
 * Handles all business logic for Buyer Profile operations.
 * Uses an in-memory store for development/testing.
 * In production, this would be replaced with a database repository.
 */

import { v4 as uuidv4 } from "uuid";
import {
  BuyerProfile,
  CreateBuyerProfileData,
  UpdateBuyerProfileData,
  BuyerProfileFilters,
  PaginationParams,
  PaginatedResponse,
} from "./types/buyer-profile.types.js";

/**
 * In-memory store for buyer profiles
 * In production, this would be replaced with a database
 */
const buyerProfiles: Map<string, BuyerProfile> = new Map();

/**
 * Index for userId lookups (enforces one profile per user)
 */
const userIdIndex: Map<string, string> = new Map();

/**
 * Index for email lookups (enforces unique emails)
 */
const emailIndex: Map<string, string> = new Map();

/**
 * Buyer Profile Service Class
 */
export class BuyerProfileService {
  /**
   * Create a new buyer profile
   * @throws Error if user already has a profile or email is already in use
   */
  async create(data: CreateBuyerProfileData): Promise<BuyerProfile> {
    // Check if user already has a profile
    if (userIdIndex.has(data.userId)) {
      throw new Error("User already has a buyer profile");
    }

    // Check if email is already in use
    if (emailIndex.has(data.email.toLowerCase())) {
      throw new Error("Email is already in use");
    }

    const now = new Date();
    const profile: BuyerProfile = {
      id: uuidv4(),
      userId: data.userId,
      fullName: data.fullName,
      email: data.email.toLowerCase(),
      phoneNumber: data.phoneNumber,
      address: data.address,
      avatarUrl: data.avatarUrl,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    // Store the profile
    buyerProfiles.set(profile.id, profile);
    userIdIndex.set(profile.userId, profile.id);
    emailIndex.set(profile.email, profile.id);

    return profile;
  }

  /**
   * Get a buyer profile by ID
   * @returns null if profile not found or is deleted
   */
  async getById(id: string): Promise<BuyerProfile | null> {
    const profile = buyerProfiles.get(id);

    if (!profile || profile.deletedAt) {
      return null;
    }

    return profile;
  }

  /**
   * Get a buyer profile by user ID
   * @returns null if profile not found or is deleted
   */
  async getByUserId(userId: string): Promise<BuyerProfile | null> {
    const profileId = userIdIndex.get(userId);

    if (!profileId) {
      return null;
    }

    return this.getById(profileId);
  }

  /**
   * Get a buyer profile by email
   * @returns null if profile not found or is deleted
   */
  async getByEmail(email: string): Promise<BuyerProfile | null> {
    const profileId = emailIndex.get(email.toLowerCase());

    if (!profileId) {
      return null;
    }

    return this.getById(profileId);
  }

  /**
   * List buyer profiles with optional filters and pagination
   */
  async list(
    filters: BuyerProfileFilters = {},
    pagination: PaginationParams = {}
  ): Promise<PaginatedResponse<BuyerProfile>> {
    const page = Math.max(1, pagination.page || 1);
    const limit = Math.min(100, Math.max(1, pagination.limit || 10));

    // Get all non-deleted profiles
    let profiles = Array.from(buyerProfiles.values()).filter(
      (profile) => !profile.deletedAt
    );

    // Apply filters
    if (filters.userId) {
      profiles = profiles.filter((p) => p.userId === filters.userId);
    }

    if (filters.email) {
      profiles = profiles.filter(
        (p) => p.email === filters.email?.toLowerCase()
      );
    }

    if (filters.fullName) {
      profiles = profiles.filter((p) =>
        p.fullName.toLowerCase().includes(filters.fullName!.toLowerCase())
      );
    }

    // Sort by createdAt descending
    profiles.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Calculate pagination
    const total = profiles.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    // Get paginated results
    const data = profiles.slice(startIndex, endIndex);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Update a buyer profile
   * @throws Error if email is already in use by another profile
   */
  async update(id: string, data: UpdateBuyerProfileData): Promise<BuyerProfile> {
    const profile = await this.getById(id);

    if (!profile) {
      throw new Error("Profile not found");
    }

    // Check if email is being changed and is already in use
    if (data.email && data.email.toLowerCase() !== profile.email) {
      const existingProfile = await this.getByEmail(data.email);
      if (existingProfile && existingProfile.id !== id) {
        throw new Error("Email is already in use by another profile");
      }

      // Update email index
      emailIndex.delete(profile.email);
      emailIndex.set(data.email.toLowerCase(), id);
    }

    // Update the profile
    const updatedProfile: BuyerProfile = {
      ...profile,
      ...data,
      email: data.email ? data.email.toLowerCase() : profile.email,
      updatedAt: new Date(),
    };

    buyerProfiles.set(id, updatedProfile);

    return updatedProfile;
  }

  /**
   * Soft delete a buyer profile
   * @throws Error if profile not found
   */
  async delete(id: string): Promise<void> {
    const profile = await this.getById(id);

    if (!profile) {
      throw new Error("Profile not found");
    }

    // Soft delete
    const deletedProfile: BuyerProfile = {
      ...profile,
      deletedAt: new Date(),
      updatedAt: new Date(),
    };

    buyerProfiles.set(id, deletedProfile);

    // Remove from indexes
    userIdIndex.delete(profile.userId);
    emailIndex.delete(profile.email);
  }

  /**
   * Hard delete a buyer profile (for testing purposes)
   */
  async hardDelete(id: string): Promise<void> {
    const profile = buyerProfiles.get(id);

    if (profile) {
      buyerProfiles.delete(id);
      userIdIndex.delete(profile.userId);
      emailIndex.delete(profile.email);
    }
  }

  /**
   * Clear all profiles (for testing purposes)
   */
  async clearAll(): Promise<void> {
    buyerProfiles.clear();
    userIdIndex.clear();
    emailIndex.clear();
  }

  /**
   * Get total count of profiles (for testing purposes)
   */
  async count(): Promise<number> {
    return Array.from(buyerProfiles.values()).filter(
      (profile) => !profile.deletedAt
    ).length;
  }

  /**
   * Check if a user has a profile
   */
  async userHasProfile(userId: string): Promise<boolean> {
    return userIdIndex.has(userId);
  }
}

// Export singleton instance
export const buyerProfileService = new BuyerProfileService();

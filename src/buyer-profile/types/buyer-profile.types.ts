/**
 * Buyer Profile Types and Interfaces
 * 
 * Defines the core data structures for the Buyer Profile module.
 */

/**
 * Buyer Profile entity representing a user's profile in the system
 */
export interface BuyerProfile {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  address?: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/**
 * Buyer Profile creation data (without auto-generated fields)
 */
export interface CreateBuyerProfileData {
  userId: string;
  fullName: string;
  email: string;
  phoneNumber: string;
  address?: string;
  avatarUrl?: string;
}

/**
 * Buyer Profile update data (all fields optional for partial updates)
 */
export interface UpdateBuyerProfileData {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
  avatarUrl?: string;
}

/**
 * Buyer Profile query filters for listing/searching
 */
export interface BuyerProfileFilters {
  userId?: string;
  email?: string;
  fullName?: string;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page?: number;
  limit?: number;
}

/**
 * Paginated response structure
 */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * API response structure
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

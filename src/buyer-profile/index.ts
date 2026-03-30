/**
 * Buyer Profile Module
 * 
 * Main entry point for the Buyer Profile module.
 * Exports all components for easy importing.
 */

// Types
export * from "./types/buyer-profile.types.js";

// DTOs
export * from "./dto/buyer-profile.dto.js";

// Service
export { buyerProfileService, BuyerProfileService } from "./buyer-profile.service.js";

// Controller
export { buyerProfileController, BuyerProfileController } from "./buyer-profile.controller.js";

// Routes
export { default as buyerProfileRoutes } from "./buyer-profile.routes.js";

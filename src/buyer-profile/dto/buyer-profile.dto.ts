/**
 * Buyer Profile Data Transfer Objects (DTOs)
 * 
 * Defines validation schemas and transformation logic for Buyer Profile operations.
 * Uses runtime validation since class-validator is not available in this project.
 */

import { Request, Response, NextFunction } from "express";

/**
 * Validation error structure
 */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate phone number format (basic validation)
 * Accepts formats: +1234567890, 123-456-7890, (123) 456-7890, etc.
 */
function isValidPhoneNumber(phone: string): boolean {
  const phoneRegex = /^[\d\s\-+()]{10,20}$/;
  return phoneRegex.test(phone);
}

/**
 * Validate UUID format
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate URL format
 */
function isValidURL(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize string input (trim and remove potentially dangerous characters)
 */
function sanitizeString(input: string): string {
  return input.trim().replace(/[<>]/g, "");
}

/**
 * Create Buyer Profile DTO validation
 */
export interface CreateBuyerProfileDTO {
  fullName: string;
  email: string;
  phoneNumber: string;
  address?: string;
  avatarUrl?: string;
}

/**
 * Validate Create Buyer Profile DTO
 */
export function validateCreateBuyerProfileDTO(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== "object") {
    errors.push({ field: "body", message: "Request body is required" });
    return errors;
  }

  const body = data as Record<string, unknown>;

  // Validate fullName
  if (!body.fullName || typeof body.fullName !== "string") {
    errors.push({ field: "fullName", message: "Full name is required" });
  } else if (body.fullName.trim().length < 2) {
    errors.push({ field: "fullName", message: "Full name must be at least 2 characters" });
  } else if (body.fullName.trim().length > 100) {
    errors.push({ field: "fullName", message: "Full name must not exceed 100 characters" });
  }

  // Validate email
  if (!body.email || typeof body.email !== "string") {
    errors.push({ field: "email", message: "Email is required" });
  } else if (!isValidEmail(body.email)) {
    errors.push({ field: "email", message: "Invalid email format" });
  } else if (body.email.length > 255) {
    errors.push({ field: "email", message: "Email must not exceed 255 characters" });
  }

  // Validate phoneNumber
  if (!body.phoneNumber || typeof body.phoneNumber !== "string") {
    errors.push({ field: "phoneNumber", message: "Phone number is required" });
  } else if (!isValidPhoneNumber(body.phoneNumber)) {
    errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
  }

  // Validate address (optional)
  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") {
      errors.push({ field: "address", message: "Address must be a string" });
    } else if (body.address.length > 500) {
      errors.push({ field: "address", message: "Address must not exceed 500 characters" });
    }
  }

  // Validate avatarUrl (optional)
  if (body.avatarUrl !== undefined && body.avatarUrl !== null) {
    if (typeof body.avatarUrl !== "string") {
      errors.push({ field: "avatarUrl", message: "Avatar URL must be a string" });
    } else if (!isValidURL(body.avatarUrl)) {
      errors.push({ field: "avatarUrl", message: "Invalid URL format" });
    }
  }

  return errors;
}

/**
 * Update Buyer Profile DTO validation
 */
export interface UpdateBuyerProfileDTO {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
  avatarUrl?: string;
}

/**
 * Validate Update Buyer Profile DTO
 */
export function validateUpdateBuyerProfileDTO(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== "object") {
    errors.push({ field: "body", message: "Request body is required" });
    return errors;
  }

  const body = data as Record<string, unknown>;

  // Check if at least one field is provided
  const hasAtLeastOneField = 
    body.fullName !== undefined ||
    body.email !== undefined ||
    body.phoneNumber !== undefined ||
    body.address !== undefined ||
    body.avatarUrl !== undefined;

  if (!hasAtLeastOneField) {
    errors.push({ field: "body", message: "At least one field must be provided for update" });
    return errors;
  }

  // Validate fullName (optional)
  if (body.fullName !== undefined) {
    if (typeof body.fullName !== "string") {
      errors.push({ field: "fullName", message: "Full name must be a string" });
    } else if (body.fullName.trim().length < 2) {
      errors.push({ field: "fullName", message: "Full name must be at least 2 characters" });
    } else if (body.fullName.trim().length > 100) {
      errors.push({ field: "fullName", message: "Full name must not exceed 100 characters" });
    }
  }

  // Validate email (optional)
  if (body.email !== undefined) {
    if (typeof body.email !== "string") {
      errors.push({ field: "email", message: "Email must be a string" });
    } else if (!isValidEmail(body.email)) {
      errors.push({ field: "email", message: "Invalid email format" });
    } else if (body.email.length > 255) {
      errors.push({ field: "email", message: "Email must not exceed 255 characters" });
    }
  }

  // Validate phoneNumber (optional)
  if (body.phoneNumber !== undefined) {
    if (typeof body.phoneNumber !== "string") {
      errors.push({ field: "phoneNumber", message: "Phone number must be a string" });
    } else if (!isValidPhoneNumber(body.phoneNumber)) {
      errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
    }
  }

  // Validate address (optional)
  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") {
      errors.push({ field: "address", message: "Address must be a string" });
    } else if (body.address.length > 500) {
      errors.push({ field: "address", message: "Address must not exceed 500 characters" });
    }
  }

  // Validate avatarUrl (optional)
  if (body.avatarUrl !== undefined && body.avatarUrl !== null) {
    if (typeof body.avatarUrl !== "string") {
      errors.push({ field: "avatarUrl", message: "Avatar URL must be a string" });
    } else if (!isValidURL(body.avatarUrl)) {
      errors.push({ field: "avatarUrl", message: "Invalid URL format" });
    }
  }

  return errors;
}

/**
 * Validate UUID parameter
 */
export function validateUUIDParam(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== "object") {
    errors.push({ field: "params", message: "Request params are required" });
    return errors;
  }

  const params = data as Record<string, unknown>;

  if (!params.id || typeof params.id !== "string") {
    errors.push({ field: "id", message: "Profile ID is required" });
  } else if (!isValidUUID(params.id)) {
    errors.push({ field: "id", message: "Invalid UUID format" });
  }

  return errors;
}

/**
 * Transform create DTO to service data
 */
export function transformCreateDTO(dto: CreateBuyerProfileDTO): CreateBuyerProfileDTO {
  return {
    fullName: sanitizeString(dto.fullName),
    email: dto.email.trim().toLowerCase(),
    phoneNumber: dto.phoneNumber.trim(),
    address: dto.address ? sanitizeString(dto.address) : undefined,
    avatarUrl: dto.avatarUrl?.trim(),
  };
}

/**
 * Transform update DTO to service data
 */
export function transformUpdateDTO(dto: UpdateBuyerProfileDTO): UpdateBuyerProfileDTO {
  const transformed: UpdateBuyerProfileDTO = {};

  if (dto.fullName !== undefined) {
    transformed.fullName = sanitizeString(dto.fullName);
  }
  if (dto.email !== undefined) {
    transformed.email = dto.email.trim().toLowerCase();
  }
  if (dto.phoneNumber !== undefined) {
    transformed.phoneNumber = dto.phoneNumber.trim();
  }
  if (dto.address !== undefined) {
    transformed.address = dto.address ? sanitizeString(dto.address) : undefined;
  }
  if (dto.avatarUrl !== undefined) {
    transformed.avatarUrl = dto.avatarUrl?.trim();
  }

  return transformed;
}

/**
 * Middleware to validate create buyer profile request
 */
export function validateCreateBuyerProfile(req: Request, res: Response, next: NextFunction) {
  const errors = validateCreateBuyerProfileDTO(req.body);

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors,
    });
  }

  // Transform the data
  req.body = transformCreateDTO(req.body as CreateBuyerProfileDTO);
  next();
}

/**
 * Middleware to validate update buyer profile request
 */
export function validateUpdateBuyerProfile(req: Request, res: Response, next: NextFunction) {
  const errors = validateUpdateBuyerProfileDTO(req.body);

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors,
    });
  }

  // Transform the data
  req.body = transformUpdateDTO(req.body as UpdateBuyerProfileDTO);
  next();
}

/**
 * Middleware to validate UUID parameter
 */
export function validateUUID(req: Request, res: Response, next: NextFunction) {
  const errors = validateUUIDParam(req.params);

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors,
    });
  }

  next();
}

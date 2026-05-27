/**
 * Buyer Profile Data Transfer Objects (DTOs)
 *
 * Validation, allowlist enforcement, and normalization for Buyer Profile operations.
 */

import { Request, Response, NextFunction } from "express";

export interface ValidationError {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/** Accepted fields for create requests. Any other key is rejected. */
const CREATE_ALLOWLIST = new Set(["fullName", "email", "phoneNumber", "address", "avatarUrl"]);

/** Accepted fields for update requests. Any other key is rejected. */
const UPDATE_ALLOWLIST = new Set(["fullName", "email", "phoneNumber", "address", "avatarUrl"]);

// ---------------------------------------------------------------------------
// Length limits
// ---------------------------------------------------------------------------

const LIMITS = {
  fullName: { min: 2, max: 100 },
  email: { max: 255 },
  phoneNumber: { min: 7, max: 20 },
  address: { max: 500 },
  avatarUrl: { max: 2048 },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize all unicode whitespace variants to a single ASCII space, then trim. */
function normalizeWhitespace(s: string): string {
  // \p{Z} covers all Unicode separator categories; \s covers ASCII control whitespace
  return s.replace(/[\p{Z}\s]+/gu, " ").trim();
}

/** Sanitize a text field: normalize whitespace and strip < > to prevent injection. */
function sanitizeString(input: string): string {
  return normalizeWhitespace(input).replace(/[<>]/g, "");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Phone: digits, spaces, hyphens, plus, parentheses only.
 * Length enforced separately via LIMITS.
 */
function isValidPhoneNumber(phone: string): boolean {
  return /^[\d\s\-+()]+$/.test(phone);
}

function isValidUUID(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

function isValidURL(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * fullName must contain only letters (any script), spaces, hyphens, apostrophes, and periods.
 * Rejects digits and most special characters.
 */
function isValidFullName(name: string): boolean {
  return /^[\p{L}\p{M}'\-. ]+$/u.test(name);
}

/** Return the set of unknown keys in body relative to an allowlist. */
function unknownFields(body: Record<string, unknown>, allowlist: Set<string>): string[] {
  return Object.keys(body).filter((k) => !allowlist.has(k));
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface CreateBuyerProfileDTO {
  fullName: string;
  email: string;
  phoneNumber: string;
  address?: string;
  avatarUrl?: string;
}

export interface UpdateBuyerProfileDTO {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  address?: string;
  avatarUrl?: string;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateCreateBuyerProfileDTO(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== "object") {
    errors.push({ field: "body", message: "Request body is required" });
    return errors;
  }

  const body = data as Record<string, unknown>;

  // Allowlist check
  const unknown = unknownFields(body, CREATE_ALLOWLIST);
  if (unknown.length > 0) {
    errors.push({ field: "body", message: `Unknown field(s): ${unknown.join(", ")}` });
  }

  // fullName
  if (!body.fullName || typeof body.fullName !== "string") {
    errors.push({ field: "fullName", message: "Full name is required" });
  } else {
    const name = normalizeWhitespace(body.fullName);
    if (name.length < LIMITS.fullName.min) {
      errors.push({ field: "fullName", message: "Full name must be at least 2 characters" });
    } else if (name.length > LIMITS.fullName.max) {
      errors.push({ field: "fullName", message: "Full name must not exceed 100 characters" });
    } else if (!isValidFullName(name)) {
      errors.push({ field: "fullName", message: "Full name contains invalid characters" });
    }
  }

  // email
  if (!body.email || typeof body.email !== "string") {
    errors.push({ field: "email", message: "Email is required" });
  } else if (!isValidEmail(body.email)) {
    errors.push({ field: "email", message: "Invalid email format" });
  } else if (body.email.length > LIMITS.email.max) {
    errors.push({ field: "email", message: "Email must not exceed 255 characters" });
  }

  // phoneNumber
  if (!body.phoneNumber || typeof body.phoneNumber !== "string") {
    errors.push({ field: "phoneNumber", message: "Phone number is required" });
  } else {
    const phone = body.phoneNumber.trim();
    if (phone.length < LIMITS.phoneNumber.min) {
      errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
    } else if (phone.length > LIMITS.phoneNumber.max) {
      errors.push({ field: "phoneNumber", message: "Phone number must not exceed 20 characters" });
    } else if (!isValidPhoneNumber(phone)) {
      errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
    }
  }

  // address (optional)
  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") {
      errors.push({ field: "address", message: "Address must be a string" });
    } else if (body.address.length > LIMITS.address.max) {
      errors.push({ field: "address", message: "Address must not exceed 500 characters" });
    }
  }

  // avatarUrl (optional)
  if (body.avatarUrl !== undefined && body.avatarUrl !== null) {
    if (typeof body.avatarUrl !== "string") {
      errors.push({ field: "avatarUrl", message: "Avatar URL must be a string" });
    } else if (body.avatarUrl.length > LIMITS.avatarUrl.max) {
      errors.push({ field: "avatarUrl", message: "Avatar URL must not exceed 2048 characters" });
    } else if (!isValidURL(body.avatarUrl)) {
      errors.push({ field: "avatarUrl", message: "Invalid URL format" });
    }
  }

  return errors;
}

export function validateUpdateBuyerProfileDTO(data: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== "object") {
    errors.push({ field: "body", message: "Request body is required" });
    return errors;
  }

  const body = data as Record<string, unknown>;

  // Allowlist check
  const unknown = unknownFields(body, UPDATE_ALLOWLIST);
  if (unknown.length > 0) {
    errors.push({ field: "body", message: `Unknown field(s): ${unknown.join(", ")}` });
  }

  // At least one known field required
  const hasField = UPDATE_ALLOWLIST.size > 0 &&
    [...UPDATE_ALLOWLIST].some((k) => body[k] !== undefined);
  if (!hasField) {
    errors.push({ field: "body", message: "At least one field must be provided for update" });
    return errors;
  }

  if (body.fullName !== undefined) {
    if (typeof body.fullName !== "string") {
      errors.push({ field: "fullName", message: "Full name must be a string" });
    } else {
      const name = normalizeWhitespace(body.fullName);
      if (name.length < LIMITS.fullName.min) {
        errors.push({ field: "fullName", message: "Full name must be at least 2 characters" });
      } else if (name.length > LIMITS.fullName.max) {
        errors.push({ field: "fullName", message: "Full name must not exceed 100 characters" });
      } else if (!isValidFullName(name)) {
        errors.push({ field: "fullName", message: "Full name contains invalid characters" });
      }
    }
  }

  if (body.email !== undefined) {
    if (typeof body.email !== "string") {
      errors.push({ field: "email", message: "Email must be a string" });
    } else if (!isValidEmail(body.email)) {
      errors.push({ field: "email", message: "Invalid email format" });
    } else if (body.email.length > LIMITS.email.max) {
      errors.push({ field: "email", message: "Email must not exceed 255 characters" });
    }
  }

  if (body.phoneNumber !== undefined) {
    if (typeof body.phoneNumber !== "string") {
      errors.push({ field: "phoneNumber", message: "Phone number must be a string" });
    } else {
      const phone = body.phoneNumber.trim();
      if (phone.length < LIMITS.phoneNumber.min) {
        errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
      } else if (phone.length > LIMITS.phoneNumber.max) {
        errors.push({ field: "phoneNumber", message: "Phone number must not exceed 20 characters" });
      } else if (!isValidPhoneNumber(phone)) {
        errors.push({ field: "phoneNumber", message: "Invalid phone number format" });
      }
    }
  }

  if (body.address !== undefined && body.address !== null) {
    if (typeof body.address !== "string") {
      errors.push({ field: "address", message: "Address must be a string" });
    } else if (body.address.length > LIMITS.address.max) {
      errors.push({ field: "address", message: "Address must not exceed 500 characters" });
    }
  }

  if (body.avatarUrl !== undefined && body.avatarUrl !== null) {
    if (typeof body.avatarUrl !== "string") {
      errors.push({ field: "avatarUrl", message: "Avatar URL must be a string" });
    } else if (body.avatarUrl.length > LIMITS.avatarUrl.max) {
      errors.push({ field: "avatarUrl", message: "Avatar URL must not exceed 2048 characters" });
    } else if (!isValidURL(body.avatarUrl)) {
      errors.push({ field: "avatarUrl", message: "Invalid URL format" });
    }
  }

  return errors;
}

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

// ---------------------------------------------------------------------------
// Transformers — produce a clean, allowlisted object (unknown keys dropped)
// ---------------------------------------------------------------------------

export function transformCreateDTO(dto: CreateBuyerProfileDTO): CreateBuyerProfileDTO {
  return {
    fullName: sanitizeString(dto.fullName),
    email: dto.email.trim().toLowerCase(),
    phoneNumber: dto.phoneNumber.trim(),
    ...(dto.address != null ? { address: sanitizeString(dto.address) } : {}),
    ...(dto.avatarUrl != null ? { avatarUrl: dto.avatarUrl.trim() } : {}),
  };
}

export function transformUpdateDTO(dto: UpdateBuyerProfileDTO): UpdateBuyerProfileDTO {
  const out: UpdateBuyerProfileDTO = {};
  if (dto.fullName !== undefined) out.fullName = sanitizeString(dto.fullName);
  if (dto.email !== undefined) out.email = dto.email.trim().toLowerCase();
  if (dto.phoneNumber !== undefined) out.phoneNumber = dto.phoneNumber.trim();
  if (dto.address !== undefined) out.address = dto.address ? sanitizeString(dto.address) : undefined;
  if (dto.avatarUrl !== undefined) out.avatarUrl = dto.avatarUrl?.trim();
  return out;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function validateCreateBuyerProfile(req: Request, res: Response, next: NextFunction) {
  const errors = validateCreateBuyerProfileDTO(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: "Validation failed", details: errors });
  }
  req.body = transformCreateDTO(req.body as CreateBuyerProfileDTO);
  next();
}

export function validateUpdateBuyerProfile(req: Request, res: Response, next: NextFunction) {
  const errors = validateUpdateBuyerProfileDTO(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: "Validation failed", details: errors });
  }
  req.body = transformUpdateDTO(req.body as UpdateBuyerProfileDTO);
  next();
}

export function validateUUID(req: Request, res: Response, next: NextFunction) {
  const errors = validateUUIDParam(req.params);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: "Validation failed", details: errors });
  }
  next();
}

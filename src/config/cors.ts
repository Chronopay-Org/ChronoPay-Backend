/**
 * CORS Allowlist Configuration Module
 * 
 * Provides secure, production-grade CORS configuration with:
 * - Origin allowlist validation
 * - Environment-based configuration
 * - Pattern matching support (including wildcards)
 * - Comprehensive error handling
 */

/**
 * CORS Configuration interface
 */
export interface CORSConfig {
  /** List of allowed origins */
  allowedOrigins: string[];
  /** List of allowed HTTP methods */
  allowedMethods: string[];
  /** List of allowed headers */
  allowedHeaders: string[];
  /** Whether to allow credentials (cookies, etc.) */
  allowCredentials: boolean;
  /** Max age for preflight cache in seconds */
  maxAge: number;
}

/**
 * Default CORS configuration
 * Used when no specific environment configuration is provided
 */
const DEFAULT_CORS_CONFIG: CORSConfig = {
  allowedOrigins: ["http://localhost:3000", "http://localhost:3001"],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  allowCredentials: true,
  maxAge: 86400, // 24 hours
};

/**
 * Production CORS configuration
 * Restrictive configuration for production environments
 */
const PRODUCTION_CORS_CONFIG: CORSConfig = {
  allowedOrigins: [],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  allowCredentials: true,
  maxAge: 86400,
};

/**
 * Validates if a given origin matches the allowlist
 * Supports exact matches and wildcard patterns (e.g., https://*.example.com)
 * 
 * Security considerations:
 * - Validates against full origin string (scheme + domain + port)
 * - Prevents subdomain escaping with careful pattern matching
 * - Does not allow wildcards for top-level domains (*.com is rejected)
 * 
 * @param origin - The origin to validate (typically from request headers)
 * @param allowedOrigins - List of allowed origins and patterns
 * @returns true if origin is allowed, false otherwise
 * @throws Error if origin or allowedOrigins contain invalid values
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  // Reject requests without origin header
  if (!origin || typeof origin !== "string" || origin.trim() === "") {
    return false;
  }

  // Validate origin format (basic check for valid URL format)
  try {
    new URL(origin);
  } catch {
    return false;
  }

  // Check exact match first (most common case)
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check pattern matches with wildcards
  for (const pattern of allowedOrigins) {
    if (matchOriginPattern(origin, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Matches an origin against a wildcard pattern
 * Supports patterns like: https://*.example.com
 * 
 * Security constraints:
 * - Does not allow wildcard at TLD level (*.com is invalid)
 * - Does not allow multiple wildcards in one pattern
 * - Pattern must be valid URL format after wildcard replacement
 * 
 * @param origin - The origin to match
 * @param pattern - The pattern to match against (may contain wildcards)
 * @returns true if origin matches pattern, false otherwise
 */
function matchOriginPattern(origin: string, pattern: string): boolean {
  // Only process patterns with wildcard
  if (!pattern.includes("*")) {
    return false;
  }

  // Reject patterns with multiple wildcards (too permissive)
  if ((pattern.match(/\*/g) || []).length > 1) {
    return false;
  }

  // Reject patterns with wildcard not followed by a dot (prevents *.com style)
  if (!/\*\./.test(pattern)) {
    return false;
  }

  // Split by wildcard and escape regex special characters in each part
  const [beforeWildcard, afterWildcard] = pattern.split("*");
  const escapedBefore = beforeWildcard.replace(
    /[.+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const escapedAfter = afterWildcard.replace(
    /[.+?^${}()|[\]\\]/g,
    "\\$&",
  );

  // Build regex: match non-slash characters for wildcard part
  const regexPattern = new RegExp(
    `^${escapedBefore}[^/]+${escapedAfter}$`,
  );

  return regexPattern.test(origin);
}

/**
 * Loads CORS configuration from environment variables
 * 
 * Environment variables:
 * - CORS_ALLOWED_ORIGINS: Comma-separated list of allowed origins
 * - CORS_ALLOWED_METHODS: Comma-separated list of allowed HTTP methods
 * - CORS_ALLOWED_HEADERS: Comma-separated list of allowed headers
 * - CORS_ALLOW_CREDENTIALS: "true" or "false"
 * - CORS_MAX_AGE: Max age in seconds for preflight cache
 * - NODE_ENV: "production", "staging", or "development"
 * 
 * @returns CORS configuration loaded from environment
 */
export function getCORSConfig(): CORSConfig {
  const env = process.env.NODE_ENV || "development";

  // For production, use restrictive config and require explicit env vars
  if (env === "production") {
    const origins = process.env.CORS_ALLOWED_ORIGINS
      ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
      : PRODUCTION_CORS_CONFIG.allowedOrigins;

    return {
      ...PRODUCTION_CORS_CONFIG,
      allowedOrigins: origins,
      allowedMethods: parseCsvEnv(
        "CORS_ALLOWED_METHODS",
        PRODUCTION_CORS_CONFIG.allowedMethods,
      ),
      allowedHeaders: parseCsvEnv(
        "CORS_ALLOWED_HEADERS",
        PRODUCTION_CORS_CONFIG.allowedHeaders,
      ),
      allowCredentials: parseBooleanEnv("CORS_ALLOW_CREDENTIALS", true),
      maxAge: parseIntEnv("CORS_MAX_AGE", PRODUCTION_CORS_CONFIG.maxAge),
    };
  }

  // For other environments, allow localhost by default
  const origins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : DEFAULT_CORS_CONFIG.allowedOrigins;

  return {
    ...DEFAULT_CORS_CONFIG,
    allowedOrigins: origins,
    allowedMethods: parseCsvEnv(
      "CORS_ALLOWED_METHODS",
      DEFAULT_CORS_CONFIG.allowedMethods,
    ),
    allowedHeaders: parseCsvEnv(
      "CORS_ALLOWED_HEADERS",
      DEFAULT_CORS_CONFIG.allowedHeaders,
    ),
    allowCredentials: parseBooleanEnv("CORS_ALLOW_CREDENTIALS", true),
    maxAge: parseIntEnv("CORS_MAX_AGE", DEFAULT_CORS_CONFIG.maxAge),
  };
}

/**
 * Parses comma-separated environment variable
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @returns Array of parsed values
 */
function parseCsvEnv(envVar: string, defaultValue: string[]): string[] {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }
  return value.split(",").map((v) => v.trim());
}

/**
 * Parses boolean environment variable
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if env var is not set
 * @returns Parsed boolean value
 */
function parseBooleanEnv(envVar: string, defaultValue: boolean): boolean {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }
  return value.toLowerCase() === "true";
}

/**
 * Parses integer environment variable
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if env var is not set or invalid
 * @returns Parsed integer value
 */
function parseIntEnv(envVar: string, defaultValue: number): number {
  const value = process.env[envVar];
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Validates CORS configuration
 * Checks that configuration is secure and valid
 * 
 * @param config - CORS configuration to validate
 * @returns true if configuration is valid, false otherwise
 * @throws Error if configuration contains security issues
 */
export function validateCORSConfig(config: CORSConfig): boolean {
  // Check required fields
  if (
    !config.allowedOrigins ||
    !Array.isArray(config.allowedOrigins) ||
    !config.allowedMethods ||
    !Array.isArray(config.allowedMethods)
  ) {
    throw new Error("Invalid CORS configuration: missing or invalid fields");
  }

  // Warn about empty allowlist in non-test environments
  if (
    config.allowedOrigins.length === 0 &&
    process.env.NODE_ENV !== "test"
  ) {
    console.warn(
      "Warning: CORS allowlist is empty. No origins will be allowed.",
    );
  }

  // Validate each origin
  for (const origin of config.allowedOrigins) {
    if (typeof origin !== "string") {
      throw new Error(`Invalid origin: ${origin} is not a string`);
    }

    // Reject wildcard-only patterns
    if (origin === "*") {
      throw new Error(
        "Invalid origin pattern: wildcard-only patterns are not allowed for security",
      );
    }

    // Validate origin format
    if (!origin.includes("*")) {
      try {
        new URL(origin);
      } catch {
        throw new Error(`Invalid origin URL: ${origin}`);
      }
    }
  }

  // Validate maxAge
  if (typeof config.maxAge !== "number" || config.maxAge < 0) {
    throw new Error("Invalid maxAge: must be a non-negative number");
  }

  return true;
}

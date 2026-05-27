/**
 * Security Headers Middleware
 *
 * Applies a baseline set of security headers to all API responses.
 * Suitable for API services with optional documentation serving.
 *
 * Headers applied:
 * - X-Content-Type-Options: nosniff (prevent MIME type sniffing)
 * - X-Frame-Options: DENY (prevent clickjacking)
 * - Referrer-Policy: strict-origin-when-cross-origin (control referrer leakage)
 * - Permissions-Policy: geolocation=(), microphone=(), camera=() (disable unnecessary APIs)
 * - Content-Security-Policy: conservative baseline (if serving docs)
 */

import { Request, Response, NextFunction } from "express";

export interface SecurityHeadersOptions {
    /**
     * Enable Content-Security-Policy header.
     * Set to true if serving Swagger UI or other documentation.
     * @default false
     */
    enableCSP?: boolean;

    /**
     * Custom CSP directives to merge with defaults.
     * @default {}
     */
    cspDirectives?: Record<string, string>;

    /**
     * Enable X-Frame-Options header.
     * @default true
     */
    enableFrameOptions?: boolean;

    /**
     * Enable Referrer-Policy header.
     * @default true
     */
    enableReferrerPolicy?: boolean;

    /**
     * Enable Permissions-Policy header.
     * @default true
     */
    enablePermissionsPolicy?: boolean;
}

/**
 * Default CSP directives for API services.
 * Conservative baseline that allows self-hosted resources and external APIs.
 */
const DEFAULT_CSP_DIRECTIVES: Record<string, string> = {
    "default-src": "'self'",
    "script-src": "'self' 'unsafe-inline'", // Swagger UI requires unsafe-inline
    "style-src": "'self' 'unsafe-inline'", // Swagger UI requires unsafe-inline
    "img-src": "'self' data: https:",
    "font-src": "'self' data:",
    "connect-src": "'self'",
    "frame-ancestors": "'none'",
    "base-uri": "'self'",
    "form-action": "'self'",
};

/**
 * Converts CSP directives object to header string.
 * @param directives - CSP directives as key-value pairs
 * @returns CSP header value string
 */
function buildCSPHeader(directives: Record<string, string>): string {
    return Object.entries(directives)
        .map(([key, value]) => `${key} ${value}`)
        .join("; ");
}

/**
 * Creates security headers middleware with configurable options.
 *
 * @param options - Configuration options for security headers
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * const securityHeaders = createSecurityHeaders({
 *   enableCSP: true,
 *   cspDirectives: { "script-src": "'self' https://cdn.example.com" }
 * });
 * app.use(securityHeaders);
 * ```
 */
export function createSecurityHeaders(
    options: SecurityHeadersOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
    const {
        enableCSP = false,
        cspDirectives = {},
        enableFrameOptions = true,
        enableReferrerPolicy = true,
        enablePermissionsPolicy = true,
    } = options;

    return (req: Request, res: Response, next: NextFunction): void => {
        // ── X-Content-Type-Options: Prevent MIME type sniffing ──────────────────
        res.setHeader("X-Content-Type-Options", "nosniff");

        // ── X-Frame-Options: Prevent clickjacking ──────────────────────────────
        if (enableFrameOptions) {
            res.setHeader("X-Frame-Options", "DENY");
        }

        // ── Referrer-Policy: Control referrer information ──────────────────────
        if (enableReferrerPolicy) {
            res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        }

        // ── Permissions-Policy: Disable unnecessary browser APIs ──────────────
        if (enablePermissionsPolicy) {
            res.setHeader(
                "Permissions-Policy",
                "geolocation=(), microphone=(), camera=(), payment=()",
            );
        }

        // ── Content-Security-Policy: Baseline protection ──────────────────────
        if (enableCSP) {
            const mergedDirectives = {
                ...DEFAULT_CSP_DIRECTIVES,
                ...cspDirectives,
            };
            const cspHeader = buildCSPHeader(mergedDirectives);
            res.setHeader("Content-Security-Policy", cspHeader);
        }

        next();
    };
}

/**
 * Default security headers middleware instance.
 * Applied globally to all routes with conservative defaults.
 */
export const securityHeaders = createSecurityHeaders({
    enableCSP: false, // Disabled by default; enable if serving docs
    enableFrameOptions: true,
    enableReferrerPolicy: true,
    enablePermissionsPolicy: true,
});

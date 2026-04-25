import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { createSecurityHeaders } from "../middleware/securityHeaders.js";
import { Request, Response, NextFunction } from "express";

describe("Security Headers Middleware", () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: NextFunction;
    let setHeaderSpy: jest.Mock;

    beforeEach(() => {
        setHeaderSpy = jest.fn();
        req = {};
        res = {
            setHeader: setHeaderSpy,
        };
        next = jest.fn();
    });

    describe("Default Configuration", () => {
        it("sets X-Content-Type-Options header", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
        });

        it("sets X-Frame-Options header", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        });

        it("sets Referrer-Policy header", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith(
                "Referrer-Policy",
                "strict-origin-when-cross-origin",
            );
        });

        it("sets Permissions-Policy header", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith(
                "Permissions-Policy",
                expect.stringContaining("geolocation=()"),
            );
        });

        it("does not set CSP header by default", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            const cspCalls = setHeaderSpy.mock.calls.filter(
                (call) => call[0] === "Content-Security-Policy",
            );
            expect(cspCalls.length).toBe(0);
        });

        it("calls next middleware", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            expect(next).toHaveBeenCalled();
        });
    });

    describe("CSP Configuration", () => {
        it("sets CSP header when enabled", () => {
            const middleware = createSecurityHeaders({ enableCSP: true });
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith(
                "Content-Security-Policy",
                expect.stringContaining("default-src 'self'"),
            );
        });

        it("includes default CSP directives", () => {
            const middleware = createSecurityHeaders({ enableCSP: true });
            middleware(req as Request, res as Response, next);

            const cspCall = setHeaderSpy.mock.calls.find(
                (call) => call[0] === "Content-Security-Policy",
            );
            const cspValue = cspCall![1] as string;

            expect(cspValue).toContain("default-src 'self'");
            expect(cspValue).toContain("script-src");
            expect(cspValue).toContain("style-src");
            expect(cspValue).toContain("img-src");
            expect(cspValue).toContain("font-src");
            expect(cspValue).toContain("connect-src");
            expect(cspValue).toContain("frame-ancestors 'none'");
            expect(cspValue).toContain("base-uri 'self'");
            expect(cspValue).toContain("form-action 'self'");
        });

        it("merges custom CSP directives with defaults", () => {
            const middleware = createSecurityHeaders({
                enableCSP: true,
                cspDirectives: {
                    "script-src": "'self' https://cdn.example.com",
                },
            });
            middleware(req as Request, res as Response, next);

            const cspCall = setHeaderSpy.mock.calls.find(
                (call) => call[0] === "Content-Security-Policy",
            );
            const cspValue = cspCall![1] as string;

            expect(cspValue).toContain("script-src 'self' https://cdn.example.com");
            expect(cspValue).toContain("default-src 'self'"); // Default still present
        });

        it("allows overriding default CSP directives", () => {
            const middleware = createSecurityHeaders({
                enableCSP: true,
                cspDirectives: {
                    "default-src": "'none'",
                },
            });
            middleware(req as Request, res as Response, next);

            const cspCall = setHeaderSpy.mock.calls.find(
                (call) => call[0] === "Content-Security-Policy",
            );
            const cspValue = cspCall![1] as string;

            expect(cspValue).toContain("default-src 'none'");
        });
    });

    describe("Selective Header Disabling", () => {
        it("skips X-Frame-Options when disabled", () => {
            const middleware = createSecurityHeaders({ enableFrameOptions: false });
            middleware(req as Request, res as Response, next);

            const frameOptionsCalls = setHeaderSpy.mock.calls.filter(
                (call) => call[0] === "X-Frame-Options",
            );
            expect(frameOptionsCalls.length).toBe(0);
        });

        it("skips Referrer-Policy when disabled", () => {
            const middleware = createSecurityHeaders({ enableReferrerPolicy: false });
            middleware(req as Request, res as Response, next);

            const referrerCalls = setHeaderSpy.mock.calls.filter(
                (call) => call[0] === "Referrer-Policy",
            );
            expect(referrerCalls.length).toBe(0);
        });

        it("skips Permissions-Policy when disabled", () => {
            const middleware = createSecurityHeaders({ enablePermissionsPolicy: false });
            middleware(req as Request, res as Response, next);

            const permissionsCalls = setHeaderSpy.mock.calls.filter(
                (call) => call[0] === "Permissions-Policy",
            );
            expect(permissionsCalls.length).toBe(0);
        });

        it("always sets X-Content-Type-Options regardless of other options", () => {
            const middleware = createSecurityHeaders({
                enableFrameOptions: false,
                enableReferrerPolicy: false,
                enablePermissionsPolicy: false,
                enableCSP: false,
            });
            middleware(req as Request, res as Response, next);

            expect(setHeaderSpy).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
        });
    });

    describe("Permissions-Policy Details", () => {
        it("disables geolocation, microphone, camera, and payment APIs", () => {
            const middleware = createSecurityHeaders();
            middleware(req as Request, res as Response, next);

            const permissionsCall = setHeaderSpy.mock.calls.find(
                (call) => call[0] === "Permissions-Policy",
            );
            const permissionsValue = permissionsCall![1] as string;

            expect(permissionsValue).toContain("geolocation=()");
            expect(permissionsValue).toContain("microphone=()");
            expect(permissionsValue).toContain("camera=()");
            expect(permissionsValue).toContain("payment=()");
        });
    });

    describe("Integration with Express", () => {
        it("works as Express middleware in a chain", () => {
            const middleware = createSecurityHeaders();
            const mockNext = jest.fn();

            middleware(req as Request, res as Response, mockNext);

            expect(mockNext).toHaveBeenCalled();
            expect(setHeaderSpy).toHaveBeenCalled();
        });

        it("does not interfere with other middleware", () => {
            const middleware = createSecurityHeaders();
            const mockNext = jest.fn();

            middleware(req as Request, res as Response, mockNext);

            // Verify next is called exactly once
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });
});

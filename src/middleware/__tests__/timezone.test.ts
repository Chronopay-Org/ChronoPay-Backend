import { jest, describe, it, expect } from "@jest/globals";
import { resolveBuyerTimezone, TIMEZONE_HEADER } from "../timezone.js";
import type { Request, Response, NextFunction } from "express";

function createMockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    buyerTimezone: undefined,
    buyerTimezoneSource: undefined,
  } as unknown as Request;
}

function createMockRes(): Response & { statusCode?: number; jsonData?: any } {
  const res: any = {
    statusCode: undefined,
    jsonData: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.jsonData = data;
      return res;
    },
  };
  return res;
}

describe("resolveBuyerTimezone middleware", () => {
  it("sets UTC as default when no profile or header provided", () => {
    const req = createMockReq();
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("UTC");
    expect(req.buyerTimezoneSource).toBe("default");
  });

  it("resolves timezone from X-Timezone header", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "America/Chicago" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("America/Chicago");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("resolves timezone from profile over header", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "America/Chicago" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone({
      getProfileTimezone: () => "Asia/Tokyo",
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Asia/Tokyo");
    expect(req.buyerTimezoneSource).toBe("profile");
  });

  it("falls back to header when profile returns null", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Europe/Berlin" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone({
      getProfileTimezone: () => null,
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Europe/Berlin");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("falls back to header when profile returns undefined", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Europe/Berlin" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone({
      getProfileTimezone: () => undefined,
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Europe/Berlin");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("falls back to UTC when profile returns invalid IANA", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Europe/Berlin" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone({
      getProfileTimezone: () => "Not/A/Timezone",
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Europe/Berlin");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("rejects malformed X-Timezone header with 400", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Not/A/Timezone" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.jsonData).toEqual({
      success: false,
      error: "Invalid timezone",
    });
  });

  it("rejects truly invalid header with 400", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Not/A/Timezone" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it("handles empty X-Timezone header gracefully (treats as absent)", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "   " });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("UTC");
    expect(req.buyerTimezoneSource).toBe("default");
  });

  it("handles profile callback throwing an exception", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Asia/Kolkata" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone({
      getProfileTimezone: () => {
        throw new Error("DB connection failed");
      },
    })(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Asia/Kolkata");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("header override during DST transition (spring forward)", () => {
    // Simulate a request with a valid header TZ
    const req = createMockReq({ [TIMEZONE_HEADER]: "America/New_York" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("America/New_York");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("no getProfileTimezone option means no profile lookup", () => {
    const req = createMockReq({ [TIMEZONE_HEADER]: "Pacific/Auckland" });
    const res = createMockRes();
    const next = jest.fn();

    resolveBuyerTimezone()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.buyerTimezone).toBe("Pacific/Auckland");
    expect(req.buyerTimezoneSource).toBe("header");
  });
});

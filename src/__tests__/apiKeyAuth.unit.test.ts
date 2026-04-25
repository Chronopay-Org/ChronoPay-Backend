import { Request, Response, NextFunction } from "express";
import { deriveApiKeyId, requireApiKey } from "../middleware/apiKeyAuth.js";
import { logger } from "../utils/logger.js";

describe("API Key Identity Model", () => {
  const expectedApiKey = "test-api-key";
  const expectedApiKeyId = "apiKey_4c806362b613f7496abf284146efd31da90e4b16169fe001841ca17290f427c4";

  it("derives a stable, non-reversible apiKeyId", () => {
    const first = deriveApiKeyId(expectedApiKey);
    const second = deriveApiKeyId(expectedApiKey);

    expect(first).toBe(expectedApiKeyId);
    expect(second).toBe(expectedApiKeyId);
    expect(first).toBe(second);
    expect(first).not.toContain(expectedApiKey);
  });

  it("attaches apiKeyId to the request after successful authentication", () => {
    const req = {
      header: (name: string) => {
        if (name.toLowerCase() === "x-api-key") return expectedApiKey;
        return undefined;
      },
    } as unknown as Request;

    let statusValue: number | undefined;
    let jsonValue: unknown;
    const res = {
      status: (value: number) => {
        statusValue = value;
        return res;
      },
      json: (payload: unknown) => {
        jsonValue = payload;
        return res;
      },
    } as unknown as Response;
    const nextCalled = { called: false };
    const next: NextFunction = () => {
      nextCalled.called = true;
    };

    requireApiKey(expectedApiKey)(req, res, next);

    expect(req.apiKeyId).toBe(expectedApiKeyId);
    expect(nextCalled.called).toBe(true);
    expect(statusValue).toBeUndefined();
    expect(jsonValue).toBeUndefined();
  });

  it("does not expose raw API keys for invalid requests", () => {
    const req = {
      header: (name: string) => {
        if (name.toLowerCase() === "x-api-key") return "bad-key";
        return undefined;
      },
    } as unknown as Request;

    let statusValue: number | undefined;
    let jsonValue: unknown;
    const res = {
      status: (value: number) => {
        statusValue = value;
        return res;
      },
      json: (payload: unknown) => {
        jsonValue = payload;
        return res;
      },
    } as unknown as Response;
    const nextCalled = { called: false };
    const next: NextFunction = () => {
      nextCalled.called = true;
    };

    requireApiKey(expectedApiKey)(req, res, next);

    expect(req.apiKeyId).toBeUndefined();
    expect(statusValue).toBe(403);
    expect(jsonValue).toEqual({
      success: false,
      error: "Invalid API key",
    });
    expect(nextCalled.called).toBe(false);
  });

  it("redacts x-api-key values from logger input without throwing", () => {
    expect(() =>
      logger.info(
        { headers: { "x-api-key": "sk_live_secret_example" } },
        "incoming request"
      )
    ).not.toThrow();
  });
});

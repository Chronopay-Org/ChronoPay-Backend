import { jest } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import {
  createResidencyGuard,
  InMemoryWaiverStore,
  detectRequestRegion,
  detectDataRegion,
  deriveWaiverScope,
  WaiverRow,
} from "../services/residencyGuard.js";
import { register } from "../metrics.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockRequest(overrides: Record<string, any> = {}): Request {
  const headers: Record<string, string> = {};
  const _customHeaders: Record<string, string> = {};

  const req = {
    header: (name: string) => headers[name.toLowerCase()] ?? _customHeaders[name] ?? undefined,
    get: (name: string) => headers[name.toLowerCase()] ?? _customHeaders[name] ?? undefined,
    setHeader: (name: string, value: string) => { _customHeaders[name] = value; },
    headers,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    path: "/api/v1/data",
    originalUrl: "/api/v1/data",
    method: "GET",
    apiKeyId: undefined,
    auth: undefined,
    user: undefined,
    ...overrides,
  };

  // Allow setting headers via the headers object
  if (overrides.headers) {
    Object.assign(headers, Object.fromEntries(
      Object.entries(overrides.headers).map(([k, v]) => [k.toLowerCase(), v])
    ));
  }

  return req as unknown as Request;
}

function mockResponse(): Response {
  const res: any = {
    statusCode: 200,
    _json: null,
    json: jest.fn((data: any) => { res._json = data; return res; }),
    status: jest.fn((code: number) => { res.statusCode = code; return res; }),
    end: jest.fn(() => res),
  };
  return res as Response;
}

function nextFn(): NextFunction {
  return jest.fn() as unknown as NextFunction;
}

function makeWaiver(
  id: string,
  scope: string,
  targetRegion: string,
  expiresHoursFromNow: number = 24,
): WaiverRow {
  const expiresAt = new Date(Date.now() + expiresHoursFromNow * 60 * 60 * 1000);
  return {
    id,
    target_region: targetRegion,
    scope,
    expires_at: expiresAt,
    created_at: new Date(),
    created_by: "admin",
  };
}

async function metricValue(metricName: string): Promise<number> {
  const text = await register.metrics();
  const line = text
    .split("\n")
    .find((l) => l.startsWith(metricName) && !l.startsWith("#"));
  if (!line) return 0;
  const parts = line.trim().split(/\s+/);
  return Number(parts[parts.length - 1]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("residency guard", () => {
  let waiverStore: InMemoryWaiverStore;

  beforeEach(() => {
    waiverStore = new InMemoryWaiverStore();
    register.resetMetrics();
  });

  // ── Region detection ──────────────────────────────────────────────────────

  describe("detectRequestRegion", () => {
    it("returns the x-region header when present", () => {
      const req = mockRequest({ headers: { "x-region": "eu-west-1" } });
      expect(detectRequestRegion(req)).toBe("eu-west-1");
    });

    it("falls back to CloudFront-Viewer-Country header", () => {
      const req = mockRequest({ headers: { "cloudfront-viewer-country": "DE" } });
      expect(detectRequestRegion(req)).toBe("de");
    });

    it("returns default region when no headers are present", () => {
      const req = mockRequest();
      // DEFAULT_DATA_REGION env fallback is "us-east-1"
      expect(detectRequestRegion(req)).toBe("us-east-1");
    });
  });

  describe("detectDataRegion", () => {
    it("returns the x-data-region header when present", () => {
      const req = mockRequest({ headers: { "x-data-region": "eu-west-1" } });
      expect(detectDataRegion(req)).toBe("eu-west-1");
    });

    it("returns default region when no x-data-region header", () => {
      const req = mockRequest();
      expect(detectDataRegion(req)).toBe("us-east-1");
    });
  });

  // ── Identity scoping ──────────────────────────────────────────────────────

  describe("deriveWaiverScope", () => {
    it("returns apiKey scope when req.apiKeyId is set", () => {
      const req = mockRequest({ apiKeyId: "apiKey_abc123" });
      expect(deriveWaiverScope(req)).toBe("apiKey:apiKey_abc123");
    });

    it("returns user scope when req.auth.userId is set", () => {
      const req = mockRequest({ auth: { userId: "user_456" } });
      expect(deriveWaiverScope(req)).toBe("user:user_456");
    });

    it("returns user scope from req.user.sub", () => {
      const req = mockRequest({ user: { sub: "user_789" } });
      expect(deriveWaiverScope(req)).toBe("user:user_789");
    });

    it("falls back to IP-based scope", () => {
      const req = mockRequest({ ip: "10.0.0.1" });
      expect(deriveWaiverScope(req)).toBe("ip:10.0.0.1");
    });
  });

  // ── Egress guard middleware ───────────────────────────────────────────────

  describe("createResidencyGuard", () => {
    it("allows same-region requests through", async () => {
      const guard = createResidencyGuard(waiverStore, ["eu-west-1"]);
      const req = mockRequest({ headers: { "x-region": "eu-west-1", "x-data-region": "eu-west-1" } });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.residencyWaived).toBe(true);
    });

    it("allows requests from a local region regardless of data region", async () => {
      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      // Request from us-east-1 (local) to eu-west-1 (foreign) — allowed
      const req = mockRequest({ headers: { "x-region": "us-east-1", "x-data-region": "eu-west-1" } });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.residencyWaived).toBe(true);
    });

    it("allows cross-region requests with a valid waiver", async () => {
      const waiver = makeWaiver("w1", "apiKey:test-key", "eu-west-1", 24);
      waiverStore.add(waiver);

      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-data-region": "us-east-1" },
        apiKeyId: "test-key",
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.residencyWaived).toBe(true);
    });

    it("blocks cross-region requests without a valid waiver", async () => {
      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-data-region": "us-east-1" },
        apiKeyId: "test-key",
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("blocks cross-region requests with an expired waiver", async () => {
      const expiredWaiver = makeWaiver("w-expired", "apiKey:test-key", "eu-west-1", -1); // expired 1 hour ago
      waiverStore.add(expiredWaiver);

      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-data-region": "us-east-1" },
        apiKeyId: "test-key",
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("respects admin bypass header", async () => {
      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      const req = mockRequest({
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-admin-residency-bypass": "true",
        },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.residencyWaived).toBe(true);
    });

    it("increments breach metric on blocked request", async () => {
      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-data-region": "us-east-1" },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(await metricValue("residency_egress_breach_attempts_total")).toBe(1);
    });

    it("fails closed when waiver lookup throws", async () => {
      // Create a store that throws on findActiveWaivers
      const failingStore = {
        findActiveWaivers: jest.fn().mockRejectedValue(new Error("db unavailable") as never),
      };

      const guard = createResidencyGuard(failingStore as any, ["us-east-1"]);
      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-data-region": "us-east-1" },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(await metricValue("residency_egress_breach_attempts_total")).toBe(1);
    });
  });

  // ── Waiver store ─────────────────────────────────────────────────────────

  describe("InMemoryWaiverStore", () => {
    it("returns active waivers matching scope and target region", async () => {
      const store = new InMemoryWaiverStore();
      store.add(makeWaiver("w1", "apiKey:key1", "eu-west-1", 24));
      store.add(makeWaiver("w2", "apiKey:key2", "eu-west-1", 24)); // different scope
      store.add(makeWaiver("w3", "apiKey:key1", "us-east-1", 24)); // different region

      const result = await store.findActiveWaivers("apiKey:key1", "eu-west-1");
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("w1");
    });

    it("does not return expired waivers", async () => {
      const store = new InMemoryWaiverStore();
      store.add(makeWaiver("w-expired", "apiKey:key1", "eu-west-1", -1)); // expired
      store.add(makeWaiver("w-active", "apiKey:key1", "eu-west-1", 24)); // active

      const result = await store.findActiveWaivers("apiKey:key1", "eu-west-1");
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("w-active");
    });

    it("returns empty array when no waivers match", async () => {
      const store = new InMemoryWaiverStore();

      const result = await store.findActiveWaivers("apiKey:key1", "eu-west-1");
      expect(result).toEqual([]);
    });
  });
});

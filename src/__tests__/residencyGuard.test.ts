import { jest } from "@jest/globals";
import { Request, Response, NextFunction } from "express";
import {
  createResidencyGuard,
  InMemoryWaiverStore,
  SqlWaiverStore,
  detectRequestRegion,
  detectDataRegion,
  deriveWaiverScope,
  WaiverDbRow,
  resetIgnoredRegionHeadersWarning,
  WaiverRow,
  WaiverStore,
} from "../services/residencyGuard.js";
import { logger } from "../utils/logger.js";
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

// ─── Shared waiver store conformance ─────────────────────────────────────────

type TimestampRepresentation = "date" | "iso";

interface WaiverStoreHarness {
  store: WaiverStore;
  add(waiver: WaiverRow, representation?: TimestampRepresentation): void;
  reset(): void;
}

const FIXED_NOW = new Date("2030-01-01T00:00:00.000Z");

function waiverAt(
  id: string,
  scope: string,
  targetRegion: string,
  expiresAt: Date,
  createdAt: Date = new Date(FIXED_NOW.getTime() - 60_000),
): WaiverRow {
  return {
    id,
    target_region: targetRegion,
    scope,
    expires_at: expiresAt,
    created_at: createdAt,
    created_by: "conformance",
  };
}

function toDbRow(waiver: WaiverRow, representation: TimestampRepresentation): WaiverDbRow {
  return {
    ...waiver,
    expires_at:
      representation === "iso"
        ? waiver.expires_at.toISOString()
        : new Date(waiver.expires_at.getTime()),
    created_at:
      representation === "iso"
        ? waiver.created_at.toISOString()
        : new Date(waiver.created_at.getTime()),
  };
}

/**
 * Minimal in-memory stand-in for a SQL result set. It deliberately applies
 * only the scope/region predicate so the store itself is responsible for the
 * expiry boundary (including `expires_at == now`).
 */
class FakeWaiverDb {
  private rows: WaiverDbRow[] = [];

  add(waiver: WaiverRow, representation: TimestampRepresentation = "date"): void {
    this.rows.push(toDbRow(waiver, representation));
  }

  reset(): void {
    this.rows = [];
  }

  async query(_text: string, values?: unknown[]): Promise<{ rows: WaiverDbRow[] }> {
    const [scope, targetRegion] = (values ?? []) as [string | undefined, string | undefined];
    return {
      rows: this.rows
        .filter((row) => row.scope === scope && row.target_region === targetRegion)
        .map((row) => ({ ...row })),
    };
  }
}

function createInMemoryHarness(): WaiverStoreHarness {
  const store = new InMemoryWaiverStore();
  return {
    store,
    add(waiver) {
      store.add(waiver);
    },
    reset() {
      store.clear();
    },
  };
}

function createSqlHarness(): WaiverStoreHarness {
  const db = new FakeWaiverDb();
  const store = new SqlWaiverStore(db);
  return {
    store,
    add(waiver, representation = "date") {
      db.add(waiver, representation);
    },
    reset() {
      db.reset();
    },
  };
}

function runWaiverStoreConformanceTests(
  name: string,
  createHarness: () => WaiverStoreHarness,
): void {
  describe(`${name} conformance`, () => {
    let harness: WaiverStoreHarness;

    const offset = (ms: number): Date => new Date(FIXED_NOW.getTime() + ms);

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(FIXED_NOW);
      harness = createHarness();
      harness.reset();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("grants access when a matching waiver is active", async () => {
      harness.add(waiverAt("active", "apiKey:key1", "eu-west-1", offset(60_000)), "iso");

      const result = await harness.store.findActiveWaivers("apiKey:key1", "eu-west-1");

      expect(result.map((row) => row.id)).toEqual(["active"]);
    });

    it("rejects waivers that expired before now", async () => {
      harness.add(waiverAt("expired", "apiKey:key1", "eu-west-1", offset(-1)), "date");

      const result = await harness.store.findActiveWaivers("apiKey:key1", "eu-west-1");

      expect(result).toEqual([]);
    });

    it("treats expires_at == now as expired and never allows access", async () => {
      harness.add(waiverAt("boundary", "apiKey:key1", "eu-west-1", offset(0)), "iso");

      const result = await harness.store.findActiveWaivers("apiKey:key1", "eu-west-1");

      expect(result).toEqual([]);
    });

    it("filters by scope and target region", async () => {
      harness.add(waiverAt("match", "apiKey:key1", "eu-west-1", offset(60_000)));
      harness.add(waiverAt("other-scope", "apiKey:key2", "eu-west-1", offset(60_000)));
      harness.add(waiverAt("other-region", "apiKey:key1", "us-east-1", offset(60_000)));

      const result = await harness.store.findActiveWaivers("apiKey:key1", "eu-west-1");

      expect(result.map((row) => row.id)).toEqual(["match"]);
    });

    it("normalizes Date and ISO-string timestamps to Date instances", async () => {
      harness.add(waiverAt("date-row", "apiKey:key1", "eu-west-1", offset(60_000)), "date");
      harness.add(waiverAt("iso-row", "apiKey:key1", "eu-west-1", offset(120_000)), "iso");

      const result = await harness.store.findActiveWaivers("apiKey:key1", "eu-west-1");

      expect(result.map((row) => row.id)).toEqual(["date-row", "iso-row"]);
      for (const row of result) {
        expect(row.expires_at).toBeInstanceOf(Date);
        expect(row.created_at).toBeInstanceOf(Date);
        expect(Number.isNaN(row.expires_at.getTime())).toBe(false);
        expect(Number.isNaN(row.created_at.getTime())).toBe(false);
      }
    });

    it("returns an empty array when nothing matches", async () => {
      await expect(
        harness.store.findActiveWaivers("apiKey:key1", "eu-west-1"),
      ).resolves.toEqual([]);
    });
  });
}

runWaiverStoreConformanceTests("InMemoryWaiverStore", createInMemoryHarness);
runWaiverStoreConformanceTests("SqlWaiverStore", createSqlHarness);

// ─── Tests ────────────────────────────────────────────────────────────────────

const TEST_EDGE_SECRET = "test-residency-edge-secret";

describe("residency guard", () => {
  let waiverStore: InMemoryWaiverStore;
  let savedTrustHeaders: string | undefined;
  let savedEdgeSecret: string | undefined;

  beforeEach(() => {
    savedTrustHeaders = process.env.RESIDENCY_TRUST_REGION_HEADERS;
    savedEdgeSecret = process.env.RESIDENCY_EDGE_SECRET;
    delete process.env.RESIDENCY_TRUST_REGION_HEADERS;
    delete process.env.RESIDENCY_EDGE_SECRET;
    resetIgnoredRegionHeadersWarning();
    waiverStore = new InMemoryWaiverStore();
    register.resetMetrics();
  });

  afterEach(() => {
    if (savedTrustHeaders === undefined) {
      delete process.env.RESIDENCY_TRUST_REGION_HEADERS;
    } else {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = savedTrustHeaders;
    }
    if (savedEdgeSecret === undefined) {
      delete process.env.RESIDENCY_EDGE_SECRET;
    } else {
      process.env.RESIDENCY_EDGE_SECRET = savedEdgeSecret;
    }
    jest.restoreAllMocks();
  });

  // ── Region detection ──────────────────────────────────────────────────────

  describe("detectRequestRegion", () => {
    it("ignores x-region by default and returns default region", () => {
      const req = mockRequest({ headers: { "x-region": "eu-west-1" } });
      expect(detectRequestRegion(req)).toBe("us-east-1");
    });

    it("logs a warning only once when untrusted region headers are ignored", () => {
      const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => logger);
      const req = mockRequest({ headers: { "x-region": "eu-west-1" } });

      expect(detectRequestRegion(req)).toBe("us-east-1");
      expect(detectRequestRegion(req)).toBe("us-east-1");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("honours x-region when trusted headers are enabled and x-edge-secret matches", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;

      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-edge-secret": TEST_EDGE_SECRET },
      });
      expect(detectRequestRegion(req)).toBe("eu-west-1");
    });

    it("ignores x-region when trusted headers are enabled but x-edge-secret mismatches", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;

      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-edge-secret": "wrong-secret" },
      });
      expect(detectRequestRegion(req)).toBe("us-east-1");
    });

    it("ignores x-region when trusted headers are enabled but x-edge-secret is missing", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;

      const req = mockRequest({ headers: { "x-region": "eu-west-1" } });
      expect(detectRequestRegion(req)).toBe("us-east-1");
    });

    it("ignores x-region when trusted headers are enabled but RESIDENCY_EDGE_SECRET is unset", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";

      const req = mockRequest({
        headers: { "x-region": "eu-west-1", "x-edge-secret": TEST_EDGE_SECRET },
      });
      expect(detectRequestRegion(req)).toBe("us-east-1");
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
    it("ignores x-data-region by default and returns default region", () => {
      const req = mockRequest({ headers: { "x-data-region": "eu-west-1" } });
      expect(detectDataRegion(req)).toBe("us-east-1");
    });

    it("honours x-data-region when trusted headers are enabled and x-edge-secret matches", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;

      const req = mockRequest({
        headers: { "x-data-region": "eu-west-1", "x-edge-secret": TEST_EDGE_SECRET },
      });
      expect(detectDataRegion(req)).toBe("eu-west-1");
    });

    it("ignores x-data-region when trusted headers are enabled but x-edge-secret mismatches", () => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;

      const req = mockRequest({
        headers: { "x-data-region": "eu-west-1", "x-edge-secret": "wrong-secret" },
      });
      expect(detectDataRegion(req)).toBe("us-east-1");
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
    beforeEach(() => {
      process.env.RESIDENCY_TRUST_REGION_HEADERS = "true";
      process.env.RESIDENCY_EDGE_SECRET = TEST_EDGE_SECRET;
    });

    it("allows same-region requests through", async () => {
      const guard = createResidencyGuard(waiverStore, ["eu-west-1"]);
      const req = mockRequest({
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "eu-west-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.residencyWaived).toBe(true);
    });

    it("allows requests from a local region regardless of data region", async () => {
      const guard = createResidencyGuard(waiverStore, ["us-east-1"]);
      // Request from us-east-1 (local) to eu-west-1 (foreign) — allowed
      const req = mockRequest({
        headers: {
          "x-region": "us-east-1",
          "x-data-region": "eu-west-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
      });
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
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
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
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
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
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
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
          "x-edge-secret": TEST_EDGE_SECRET,
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
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(await metricValue("residency_egress_breach_attempts_total")).toBe(1);
    });

    it("fails closed when waiver lookup throws", async () => {
      // Create a store that throws on findActiveWaivers
      const failingStore: WaiverStore = {
        findActiveWaivers: jest.fn<WaiverStore["findActiveWaivers"]>().mockRejectedValue(new Error("db unavailable")),
      };

      const guard = createResidencyGuard(failingStore, ["us-east-1"]);
      const req = mockRequest({
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "us-east-1",
          "x-edge-secret": TEST_EDGE_SECRET,
        },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(await metricValue("residency_egress_breach_attempts_total")).toBe(1);
    });

    it("ignores spoofed x-region and x-data-region headers when secret mismatches", async () => {
      const guard = createResidencyGuard(waiverStore, ["eu-west-1"]);
      const req = mockRequest({
        headers: {
          "x-region": "eu-west-1",
          "x-data-region": "eu-west-1",
          "x-edge-secret": "wrong-secret",
        },
      });
      const res = mockResponse();
      const next = nextFn();

      await guard(req, res, next);

      expect(req.requestRegion).toBe("us-east-1");
      expect(req.dataRegion).toBe("us-east-1");
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

// ─── Cross-store row shape parity ────────────────────────────────────────────

describe("waiver store row shape parity", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns identical normalized shapes from SqlWaiverStore and InMemoryWaiverStore", async () => {
    const waiver = waiverAt(
      "parity",
      "apiKey:parity",
      "eu-west-1",
      new Date(FIXED_NOW.getTime() + 60_000),
      new Date(FIXED_NOW.getTime() - 60_000),
    );

    const memoryStore = new InMemoryWaiverStore();
    memoryStore.add(waiver);

    const sqlHarness = createSqlHarness();
    sqlHarness.add(waiver, "iso");

    const [memoryRow] = await memoryStore.findActiveWaivers("apiKey:parity", "eu-west-1");
    const [sqlRow] = await sqlHarness.store.findActiveWaivers("apiKey:parity", "eu-west-1");

    expect(sqlRow).toEqual(memoryRow);
    expect(Object.keys(sqlRow).sort()).toEqual(Object.keys(memoryRow).sort());
    expect(sqlRow.expires_at).toBeInstanceOf(Date);
    expect(sqlRow.created_at).toBeInstanceOf(Date);
  });

  it("returns identical normalized shapes regardless of Date or ISO-string storage", async () => {
    const waiver = waiverAt(
      "representation",
      "apiKey:representation",
      "eu-west-1",
      new Date(FIXED_NOW.getTime() + 60_000),
    );

    const dateHarness = createSqlHarness();
    dateHarness.add(waiver, "date");
    const isoHarness = createSqlHarness();
    isoHarness.add(waiver, "iso");

    const [dateRow] = await dateHarness.store.findActiveWaivers(
      "apiKey:representation",
      "eu-west-1",
    );
    const [isoRow] = await isoHarness.store.findActiveWaivers(
      "apiKey:representation",
      "eu-west-1",
    );

    expect(isoRow).toEqual(dateRow);
    expect(isoRow.expires_at).toBeInstanceOf(Date);
    expect(isoRow.created_at).toBeInstanceOf(Date);
  });
});

/**
 * Focused behaviour coverage for `src/middleware/timezone.ts`.
 *
 * `resolveBuyerTimezone` resolves a buyer's display timezone via the chain
 * profile -> `X-Timezone` header -> UTC, decorating the request with
 * `req.buyerTimezone` and `req.buyerTimezoneSource`. A malformed header is
 * rejected with a 400 so that arbitrary strings never reach downstream
 * formatting.
 *
 * Determinism notes:
 *  - Timezone resolution is a pure `Intl.DateTimeFormat` lookup; it reads no
 *    clock, so no fake timers are needed and results cannot drift by host `TZ`.
 *  - The identifiers below are restricted to full-ICU zones that are stable
 *    across Node builds. Obscure identifiers such as `Etc/GMT+14` were
 *    rejected on Node 20 and would make the fixtures flaky.
 *  - DST-dependent offset formatting lives in `formatToTimezoneOffset` and is
 *    covered by `src/services/__tests__/timezoneService.test.ts`. Nothing here
 *    asserts an offset, so no case depends on a DST boundary.
 *
 * @see ../../services/timezoneService.ts for `resolveTimezone` /
 *       `isValidIANATimezone`.
 */

import { jest, describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  resolveBuyerTimezone,
  TIMEZONE_HEADER,
  DEFAULT_TIMEZONE,
} from "../timezone.js";
import { DEFAULT_TIMEZONE as SERVICE_DEFAULT_TIMEZONE } from "../../services/timezoneService.js";

type ProfileLookup = (req: express.Request) => string | null | undefined;

interface MockResponse {
  statusCode?: number;
  jsonBody?: unknown;
  /** Ordered record of `status`/`json` calls, used to assert response ordering. */
  calls: string[];
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    calls: [],
    status(code: number) {
      res.statusCode = code;
      res.calls.push(`status:${code}`);
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      res.calls.push("json");
      return res;
    },
  };
  return res;
}

function createMockReq(headers: Record<string, unknown> = {}): express.Request {
  return { headers } as unknown as express.Request;
}

function invoke(
  input: {
    headers?: Record<string, unknown>;
    getProfileTimezone?: ProfileLookup;
  } = {},
) {
  const req = createMockReq(input.headers ?? {});
  const res = createMockRes();
  const next = jest.fn();

  const options = input.getProfileTimezone
    ? { getProfileTimezone: input.getProfileTimezone }
    : undefined;

  resolveBuyerTimezone(options)(
    req,
    res as unknown as express.Response,
    next as unknown as express.NextFunction,
  );

  return { req, res, next };
}

const bodyOf = (res: MockResponse): Record<string, unknown> =>
  res.jsonBody as Record<string, unknown>;

/** The only error envelope this middleware is allowed to emit. */
const INVALID_TIMEZONE_BODY = { success: false, error: "Invalid timezone" };

describe("TIMEZONE_HEADER", () => {
  it('is exactly "x-timezone"', () => {
    expect(TIMEZONE_HEADER).toBe("x-timezone");
  });

  it("is lowercase", () => {
    // Node lowercases incoming header names, so a mixed-case constant would
    // miss every lookup and silently degrade every request to UTC.
    expect(TIMEZONE_HEADER).toBe(TIMEZONE_HEADER.toLowerCase());
  });

  it("is read with an exact lowercase-key lookup", () => {
    // Documents why the constant must match the wire casing Node produces:
    // a hand-built headers map keyed with canonical casing is not consulted.
    const { req } = invoke({ headers: { "X-Timezone": "Europe/Berlin" } });

    expect(req.buyerTimezone).toBe("UTC");
    expect(req.buyerTimezoneSource).toBe("default");
  });
});

describe("DEFAULT_TIMEZONE re-export", () => {
  it("is exported by the middleware module", () => {
    expect(DEFAULT_TIMEZONE).toBe("UTC");
  });

  it("is the same value the timezone service exports", () => {
    expect(DEFAULT_TIMEZONE).toBe(SERVICE_DEFAULT_TIMEZONE);
  });
});

describe("resolveBuyerTimezone header resolution", () => {
  const VALID_ZONES = [
    "UTC",
    "GMT",
    "America/New_York",
    "America/Chicago",
    "Europe/London",
    "Europe/Berlin",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Pacific/Auckland",
    "US/Pacific",
    "EST5EDT",
  ];

  it.each(VALID_ZONES)("resolves %p from the header", (tz) => {
    const { req, next } = invoke({
      headers: { [TIMEZONE_HEADER]: tz },
    });

    expect(req.buyerTimezone).toBe(tz);
    expect(req.buyerTimezoneSource).toBe("header");
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    ["lowercase", "utc"],
    ["uppercase", "AMERICA/NEW_YORK"],
    ["mixed case", "europe/berlin"],
  ])("accepts a %s identifier and echoes it verbatim", (_label, tz) => {
    // `Intl` resolves identifiers case-insensitively but the middleware does
    // not canonicalise, so downstream formatting receives the client's casing.
    const { req } = invoke({ headers: { [TIMEZONE_HEADER]: tz } });

    expect(req.buyerTimezone).toBe(tz);
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it("never writes a response on the success path", () => {
    const { res } = invoke({ headers: { [TIMEZONE_HEADER]: "Europe/Berlin" } });

    expect(res.calls).toEqual([]);
    expect(res.statusCode).toBeUndefined();
    expect(res.jsonBody).toBeUndefined();
  });
});

describe("resolveBuyerTimezone absence handling", () => {
  const ABSENT: [label: string, headerValue: unknown][] = [
    ["absent header", undefined],
    ["an empty string", ""],
    ["spaces only", "   "],
    ["a tab and a newline", "\t\n"],
  ];

  it.each(ABSENT)("treats %s as absent", (_label, headerValue) => {
    const { req, res, next } = invoke({
      headers: { [TIMEZONE_HEADER]: headerValue },
    });

    expect(req.buyerTimezone).toBe("UTC");
    expect(req.buyerTimezoneSource).toBe("default");
    expect(next).toHaveBeenCalledTimes(1);
    // A whitespace-only value must be ignored, never rejected.
    expect(res.calls).toEqual([]);
  });
});

describe("resolveBuyerTimezone precedence", () => {
  type PrecedenceRow = [
    label: string,
    profile: string | null | undefined,
    header: string | undefined,
    expectedTimezone: string,
    expectedSource: "profile" | "header" | "default",
  ];

  const ROWS: PrecedenceRow[] = [
    [
      "a valid profile wins over a valid header",
      "Asia/Tokyo",
      "America/Chicago",
      "Asia/Tokyo",
      "profile",
    ],
    [
      "a valid profile is used with no header",
      "Asia/Tokyo",
      undefined,
      "Asia/Tokyo",
      "profile",
    ],
    ["a null profile falls back to the header", null, "Europe/Berlin", "Europe/Berlin", "header"],
    [
      "an undefined profile falls back to the header",
      undefined,
      "Europe/Berlin",
      "Europe/Berlin",
      "header",
    ],
    [
      "an empty profile falls back to the header",
      "",
      "Europe/Berlin",
      "Europe/Berlin",
      "header",
    ],
    [
      "an invalid profile falls back to the header",
      "Not/A/Timezone",
      "Europe/Berlin",
      "Europe/Berlin",
      "header",
    ],
    [
      "an invalid profile with no header falls back to UTC",
      "Not/A/Timezone",
      undefined,
      "UTC",
      "default",
    ],
    [
      "a whitespace-only profile falls back to UTC",
      "   ",
      undefined,
      "UTC",
      "default",
    ],
  ];

  it.each(ROWS)("resolves %s", (_label, profile, header, expectedTimezone, expectedSource) => {
    const { req, res, next } = invoke({
      headers: { [TIMEZONE_HEADER]: header },
      getProfileTimezone: () => profile,
    });

    expect(req.buyerTimezone).toBe(expectedTimezone);
    expect(req.buyerTimezoneSource).toBe(expectedSource);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.calls).toEqual([]);
  });

  it("only consults the header when no profile callback is supplied", () => {
    const { req } = invoke({
      headers: { [TIMEZONE_HEADER]: "Pacific/Auckland" },
    });

    expect(req.buyerTimezone).toBe("Pacific/Auckland");
    expect(req.buyerTimezoneSource).toBe("header");
  });

  it.each([
    ["with a valid header", "Asia/Kolkata", "Asia/Kolkata", "header"],
    ["with no header", undefined, "UTC", "default"],
  ] as [label: string, header: string | undefined, expectedTz: string, expectedSource: string][])(
    "treats a throwing profile lookup as non-fatal %s",
    (_label, header, expectedTz, expectedSource) => {
      const { req, res, next } = invoke({
        headers: { [TIMEZONE_HEADER]: header },
        getProfileTimezone: () => {
          throw new Error("profile store unavailable");
        },
      });

      expect(req.buyerTimezone).toBe(expectedTz);
      expect(req.buyerTimezoneSource).toBe(expectedSource);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.calls).toEqual([]);
    },
  );

  it("confines the source label to the documented three-value domain", () => {
    const observed = [
      invoke({ getProfileTimezone: () => "Asia/Tokyo" }).req.buyerTimezoneSource,
      invoke({ headers: { [TIMEZONE_HEADER]: "Asia/Tokyo" } }).req.buyerTimezoneSource,
      invoke().req.buyerTimezoneSource,
    ];

    for (const source of observed) {
      expect(["profile", "header", "default"]).toContain(source);
    }
  });
});

describe("resolveBuyerTimezone rejection of malformed headers", () => {
  type RejectionRow = [label: string, headerValue: string];

  const ROWS: RejectionRow[] = [
    ["an unknown region", "Not/A/Timezone"],
    ["an unknown city", "Mars/Olympus_Mons"],
    ["an extra path segment", "America/New_York/extra"],
    ["a SQL injection attempt", "America/New_York'; DROP TABLE slots;--"],
    ["a script payload", "<script>alert(1)</script>"],
    ["a path traversal attempt", "../../etc/passwd"],
    ["a CRLF header injection attempt", "America/New_York\r\nX-Injected: 1"],
    ["an embedded null byte", "America/New_York\u0000"],
    ["a right-to-left override", "\u202eENER"],
    ["an emoji suffix", "Europe/Berlin\u{1F600}"],
    ["a non-ASCII identifier", "\u00dcn\u00efc\u00f6d\u00e9/Berlin"],
    ["an oversized identifier", "A".repeat(512)],
  ];

  it.each(ROWS)("rejects %s with a 400", (_label, headerValue) => {
    const { res, next } = invoke({
      headers: { [TIMEZONE_HEADER]: headerValue },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toEqual(INVALID_TIMEZONE_BODY);
  });

  it("emits the same envelope for every rejected header", () => {
    const bodies = ROWS.map(([, headerValue]) =>
      JSON.stringify(invoke({ headers: { [TIMEZONE_HEADER]: headerValue } }).res.jsonBody),
    );

    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual(INVALID_TIMEZONE_BODY);
  });

  it("sets the status before serialising the body", () => {
    const { res } = invoke({ headers: { [TIMEZONE_HEADER]: "Not/A/Timezone" } });

    expect(res.calls).toEqual(["status:400", "json"]);
  });

  it("does not echo the offending value back to the caller", () => {
    const secret = "Not/A/Timezone";
    const { res } = invoke({ headers: { [TIMEZONE_HEADER]: secret } });

    expect(JSON.stringify(res.jsonBody)).not.toContain(secret);
    expect(Object.keys(bodyOf(res))).toEqual(["success", "error"]);
  });

  it("leaves the request undecorated", () => {
    const { req } = invoke({ headers: { [TIMEZONE_HEADER]: "Not/A/Timezone" } });

    expect(req.buyerTimezone).toBeUndefined();
    expect(req.buyerTimezoneSource).toBeUndefined();
  });
});

describe("resolveBuyerTimezone boundary behaviour", () => {
  const PADDED: [label: string, headerValue: string][] = [
    ["space padded", " America/New_York "],
    ["tab padded", "\tEurope/Berlin"],
  ];

  it.each(PADDED)("rejects a %s but otherwise valid identifier", (_label, headerValue) => {
    // The guard trims only to test emptiness; it never trims before validating,
    // so padding turns an otherwise valid zone into a 400. Pinned so the
    // asymmetry stays observable rather than silently changing.
    const { res, next } = invoke({ headers: { [TIMEZONE_HEADER]: headerValue } });

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toEqual(INVALID_TIMEZONE_BODY);
    expect(next).not.toHaveBeenCalled();
  });

  it("validates the header before consulting the profile", () => {
    const getProfileTimezone = jest.fn(() => "Asia/Tokyo");

    const { res } = invoke({
      headers: { [TIMEZONE_HEADER]: "Not/A/Timezone" },
      getProfileTimezone,
    });

    expect(res.statusCode).toBe(400);
    expect(getProfileTimezone).not.toHaveBeenCalled();
  });

  it("lets a malformed header outrank an otherwise valid profile", () => {
    const { res, next } = invoke({
      headers: { [TIMEZONE_HEADER]: "Not/A/Timezone" },
      getProfileTimezone: () => "Asia/Tokyo",
    });

    expect(res.statusCode).toBe(400);
    expect(bodyOf(res)).toEqual(INVALID_TIMEZONE_BODY);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects the comma-joined value Node produces for duplicate headers", () => {
    // Node collapses repeated non-special headers into one comma-joined
    // string, which is not a valid identifier and so reaches the 400 path.
    const { res, next } = invoke({
      headers: { [TIMEZONE_HEADER]: "Europe/Berlin, Asia/Tokyo" },
    });

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("throws when the header value is not a string", () => {
    // Documented gap: `req.headers[TIMEZONE_HEADER] as string | undefined` is
    // an unsound cast, and the emptiness guard calls `.trim()` unguarded, so a
    // non-string value raises an uncaught TypeError. Not reachable over HTTP —
    // Node only ever yields strings for this header — but a future refactor of
    // the guard needs to keep this in mind.
    const req = createMockReq({ [TIMEZONE_HEADER]: ["Europe/Berlin"] });
    const res = createMockRes();

    expect(() =>
      resolveBuyerTimezone()(
        req,
        res as unknown as express.Response,
        jest.fn() as unknown as express.NextFunction,
      ),
    ).toThrow(TypeError);
  });
});

describe("resolveBuyerTimezone through an express route", () => {
  function createApp(options?: { getProfileTimezone?: ProfileLookup }) {
    const app = express();

    app.get("/tz", resolveBuyerTimezone(options), (req: express.Request, res) => {
      res.json({
        timezone: req.buyerTimezone,
        source: req.buyerTimezoneSource,
      });
    });

    return app;
  }

  const CASINGS = ["X-Timezone", "x-timezone", "X-TIMEZONE"];

  it.each(CASINGS)("resolves a header sent as %s", async (headerName) => {
    // Only an end-to-end request proves Node's lowercasing of header names
    // lines up with TIMEZONE_HEADER; a hand-built headers map cannot.
    const res = await request(createApp()).get("/tz").set(headerName, "Europe/Berlin");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: "Europe/Berlin", source: "header" });
  });

  it("falls back to UTC when the header is absent", async () => {
    const res = await request(createApp()).get("/tz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: "UTC", source: "default" });
  });

  it("returns the 400 envelope without reaching the handler", async () => {
    const res = await request(createApp())
      .get("/tz")
      .set("X-Timezone", "Not/A/Timezone");

    expect(res.status).toBe(400);
    expect(res.body).toEqual(INVALID_TIMEZONE_BODY);
    expect(res.body).not.toHaveProperty("timezone");
  });

  it("passes the request to the profile lookup", async () => {
    const app = createApp({
      getProfileTimezone: (req) => req.headers["x-profile-timezone"] as string | undefined,
    });

    const res = await request(app)
      .get("/tz")
      .set("X-Profile-Timezone", "Asia/Tokyo")
      .set("X-Timezone", "America/Chicago");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timezone: "Asia/Tokyo", source: "profile" });
  });
});

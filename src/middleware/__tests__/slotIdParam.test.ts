import { jest, describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import { parseSlotIdParam } from "../slotIdParam.js";

/**
 * Focused behaviour coverage for `parseSlotIdParam`.
 *
 * The middleware trims `req.params.id` and accepts it when it is either a
 * positive integer (numeric slot id) or a non-empty token matching
 * `/^[A-Za-z0-9_-]+$/` (legacy string slot id). Anything else is answered with
 * the canonical `BAD_REQUEST` envelope and `next()` is never called.
 */

interface MockResponse {
  statusCode?: number;
  jsonBody?: unknown;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res;
}

function invoke(rawId?: unknown, requestId?: string) {
  const req = {
    params: rawId === undefined ? {} : { id: rawId },
    requestId,
  } as unknown as express.Request;
  const res = createMockRes();
  const next = jest.fn();

  parseSlotIdParam(
    req,
    res as unknown as express.Response,
    next as unknown as express.NextFunction,
  );

  return { res, next };
}

const bodyOf = (res: MockResponse): Record<string, unknown> =>
  res.jsonBody as Record<string, unknown>;

describe("parseSlotIdParam", () => {
  describe("accepts valid slot ids and calls next()", () => {
    const validIds = [
      "1",
      "42",
      "999999999",
      "abc",
      "ABC",
      "slot_123",
      "slot-123",
      "A1_B2-C3",
      "_",
      "-",
      "0",
      "-5",
      "1e3",
      "1_000",
      "Infinity",
      "null",
    ];

    it.each(validIds)("accepts %p", (rawId) => {
      const { res, next } = invoke(rawId);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      // A successful validation must never write a response.
      expect(res.statusCode).toBeUndefined();
      expect(res.jsonBody).toBeUndefined();
    });

    it.each([
      ["padded numeric", "  7  ", "7"],
      ["zero padded integer", "007", "007"],
      ["explicit plus sign", "+5", "+5"],
      ["trailing decimal point", "5.", "5."],
      ["hexadecimal literal", "0x1F", "0x1F"],
      ["exponent notation", "1E3", "1E3"],
    ])("accepts %s (%p)", (_label, rawId) => {
      const { next } = invoke(rawId);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("treats a missing id as invalid rather than throwing", () => {
      const { res, next } = invoke(undefined);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);
    });
  });

  describe("rejects invalid slot ids with a 400 envelope", () => {
    const invalidIds = [
      "",
      "   ",
      "\t\n",
      "3.5",
      ".5",
      "1,000",
      "ab cd",
      "a\tb",
      "abc@def",
      "a/b",
      "a.b",
      "a,b",
      "a!b",
      "a#b",
      "a+b",
      "a\\b",
      "slöt",
      "１２３",
    ];

    it.each(invalidIds)("rejects %p", (rawId) => {
      const { res, next } = invoke(rawId);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(400);

      const body = bodyOf(res);
      expect(body).toMatchObject({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid slot id",
        error: "Invalid slot id",
      });
      expect(body.timestamp).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(body.timestamp as string))).toBe(false);
    });

    it("emits the same envelope for empty and malformed ids", () => {
      const empty = bodyOf(invoke("").res);
      const malformed = bodyOf(invoke("no spaces allowed").res);

      expect(empty).toEqual(malformed);
    });
  });

  describe("request id propagation", () => {
    it("attaches req.requestId to the error envelope when present", () => {
      const { res } = invoke("  ", "req-abc-123");

      expect(bodyOf(res).requestId).toBe("req-abc-123");
    });

    it("omits requestId when the request has none", () => {
      const { res } = invoke("  ");

      expect(bodyOf(res)).not.toHaveProperty("requestId");
    });
  });

  describe("integration through an express route", () => {
    function createApp(requestId?: string) {
      const app = express();

      if (requestId !== undefined) {
        app.use((req, _res, next) => {
          (req as express.Request & { requestId?: string }).requestId =
            requestId;
          next();
        });
      }

      app.get("/slots/:id", parseSlotIdParam, (req, res) => {
        res.status(200).json({ id: req.params.id });
      });

      return app;
    }

    it("forwards a numeric id to the handler", async () => {
      const res = await request(createApp()).get("/slots/42");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "42" });
    });

    it("forwards a legacy string id to the handler", async () => {
      const res = await request(createApp()).get("/slots/slot_123");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "slot_123" });
    });

    it("rejects a whitespace-only id with the canonical 400 envelope", async () => {
      const res = await request(createApp()).get("/slots/%20%20");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: "BAD_REQUEST",
        message: "Invalid slot id",
        error: "Invalid slot id",
      });
      expect(res.body.timestamp).toEqual(expect.any(String));
    });

    it("rejects an id containing disallowed characters", async () => {
      const res = await request(createApp()).get("/slots/a%20b");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
    });

    it("propagates the request id into the error envelope", async () => {
      const res = await request(createApp("req-123")).get("/slots/a%20b");

      expect(res.status).toBe(400);
      expect(res.body.requestId).toBe("req-123");
    });
  });
});

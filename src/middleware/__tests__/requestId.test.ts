import express from "express";
import request from "supertest";
import { getReqId } from "../../utils/logContext.js";
import { REQUEST_ID_HEADER, requestIdMiddleware, resolveRequestId } from "../requestId.js";

const GENERATED_ID_PATTERN = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestId", () => {
  it("exports the response and request header name", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  describe("resolveRequestId", () => {
    it.each(["a1234567", "a".repeat(128), "A-_.1234"])("preserves valid ID %j", (candidate) => {
      expect(resolveRequestId(candidate)).toBe(candidate);
    });

    it("trims surrounding whitespace before validating", () => {
      expect(resolveRequestId("  request-123  ")).toBe("request-123");
    });

    it.each([
      undefined,
      null,
      12345678,
      ["request-123"],
      "",
      "   ",
      "a123456",
      "a".repeat(129),
      "_1234567",
      "abc defgh",
      "abc\ndefgh",
    ])("generates an ID for invalid candidate %j", (candidate) => {
      const resolved = resolveRequestId(candidate);

      expect(resolved).toMatch(GENERATED_ID_PATTERN);
      expect(resolved).not.toBe(candidate);
    });

    it("generates a fresh ID for each invalid candidate", () => {
      expect(resolveRequestId(undefined)).not.toBe(resolveRequestId(undefined));
    });
  });

  describe("requestIdMiddleware", () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/", async (req, res) => {
      await Promise.resolve();
      res.json({ requestId: req.requestId, contextRequestId: getReqId() });
    });

    it("propagates a valid header through the request, response, and async context", async () => {
      const id = "client-123";
      const response = await request(app).get("/").set(REQUEST_ID_HEADER, ` ${id} `);

      expect(response.status).toBe(200);
      expect(response.header[REQUEST_ID_HEADER]).toBe(id);
      expect(response.body).toEqual({ requestId: id, contextRequestId: id });
    });

    it.each([undefined, "invalid id"])(
      "generates and propagates an ID when the header is %j",
      async (candidate) => {
        const call = request(app).get("/");
        if (candidate !== undefined) call.set(REQUEST_ID_HEADER, candidate);
        const response = await call;

        expect(response.status).toBe(200);
        expect(response.header[REQUEST_ID_HEADER]).toMatch(GENERATED_ID_PATTERN);
        expect(response.body).toEqual({
          requestId: response.header[REQUEST_ID_HEADER],
          contextRequestId: response.header[REQUEST_ID_HEADER],
        });
      },
    );

    it("keeps IDs separate across successive requests", async () => {
      const first = await request(app).get("/").set(REQUEST_ID_HEADER, "first-123");
      const second = await request(app).get("/").set(REQUEST_ID_HEADER, "second-123");

      expect(first.body.contextRequestId).toBe("first-123");
      expect(second.body.contextRequestId).toBe("second-123");
      expect(getReqId()).toBeUndefined();
    });
  });
});

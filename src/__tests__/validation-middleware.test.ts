import { jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { validateRequiredFields } from "../middleware/validation.js";

function createResponseMock() {
  const responseBody: unknown[] = [];
  const response = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      responseBody.push(payload);
      return this;
    },
  };

  return { response: response as unknown as Response, responseBody };
}

describe("validateRequiredFields middleware", () => {
  it("returns 400 when target data is missing or invalid", () => {
    const middleware = validateRequiredFields(["professional"], "body");
    const { response, responseBody } = createResponseMock();
    const request = { body: undefined } as unknown as Request;
    const next = jest.fn() as unknown as NextFunction;

    middleware(request, response, next);

    expect((response as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(responseBody[0]).toEqual({
      success: false,
      error: "Request body is missing or invalid",
    });
  });

  it("returns 500 when a middleware exception occurs", () => {
    const middleware = validateRequiredFields(["professional"], "body");
    const { response, responseBody } = createResponseMock();
    const request = {} as Request;
    Object.defineProperty(request, "body", {
      get() {
        throw new Error("unexpected read failure");
      },
    });
    const next = jest.fn() as unknown as NextFunction;

    middleware(request, response, next);

    expect((response as unknown as { statusCode: number }).statusCode).toBe(500);
    expect(responseBody[0]).toEqual({
      success: false,
      error: "Validation middleware error",
    });
  });
});
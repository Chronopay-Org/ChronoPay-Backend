import { validateRequiredFields } from "../middleware/validation.js";
import { mockRequest, mockResponse, mockNext } from "../utils/test-helpers.js";
import { jest } from "@jest/globals";

describe("Validation Middleware Unit Tests", () => {
  it("should call next() if all fields are present", () => {
    const req = mockRequest({ body: { field1: "val1" } });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validateRequiredFields(["field1"]);
    middleware(req as any, res as any, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should return 400 if required field is missing", () => {
    const req = mockRequest({ body: {} });
    const res = mockResponse();
    const next = mockNext();

    const middleware = validateRequiredFields(["field1"]);
    middleware(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: "Missing required field: field1"
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it("should return 400 if body is missing or invalid", () => {
    const req: any = { body: null }; // Force invalid body
    const res = mockResponse();
    const next = mockNext();

    const middleware = validateRequiredFields(["field1"]);
    middleware(req, res as any, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: "Request body is missing or invalid"
    }));
  });

  it("should return 500 if an unexpected error occurs (catch block)", () => {
    const req: any = { body: {} };
    // Proxying to throw error on access
    const proxyReq = new Proxy(req, {
      get: (target, prop) => {
        if (prop === "body") throw new Error("Forced error");
        return target[prop];
      }
    });

    const res = mockResponse();
    const next = mockNext();

    const middleware = validateRequiredFields(["field1"]);
    middleware(proxyReq as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: "Validation middleware error"
    }));
  });
});

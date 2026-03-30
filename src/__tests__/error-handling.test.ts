import request from "supertest";
import express, { Express } from "express";
import {
  createErrorHandler,
  notFoundMiddleware,
  asyncErrorHandler,
} from "../middleware/errorHandler.js";
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  InternalServerError,
  ServiceUnavailableError,
  isAppError,
  getStatusCode,
} from "../errors/AppError.js";

describe("Custom Error Classes", () => {
  describe("AppError", () => {
    it("should create error with default values", () => {
      const error = new AppError("Test error");
      expect(error.message).toBe("Test error");
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.isOperational).toBe(true);
      expect(error.name).toBe("AppError");
      expect(error.timestamp).toBeDefined();
    });

    it("should create error with custom values", () => {
      const error = new AppError("Custom error", 400, "CUSTOM_CODE", false);
      expect(error.message).toBe("Custom error");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("CUSTOM_CODE");
      expect(error.isOperational).toBe(false);
    });

    it("should serialize to JSON correctly", () => {
      const error = new AppError("Test error", 400, "BAD_REQUEST", true);
      const json = error.toJSON();

      expect(json).toEqual({
        success: false,
        error: {
          message: "Test error",
          code: "BAD_REQUEST",
          timestamp: error.timestamp,
        },
      });
    });
  });

  describe("BadRequestError", () => {
    it("should create 400 error", () => {
      const error = new BadRequestError("Invalid input");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("BAD_REQUEST");
    });

    it("should use default message", () => {
      const error = new BadRequestError();
      expect(error.message).toBe("Bad Request");
    });
  });

  describe("UnauthorizedError", () => {
    it("should create 401 error", () => {
      const error = new UnauthorizedError("Please login");
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("ForbiddenError", () => {
    it("should create 403 error", () => {
      const error = new ForbiddenError("Access denied");
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe("FORBIDDEN");
    });
  });

  describe("NotFoundError", () => {
    it("should create 404 error", () => {
      const error = new NotFoundError("User not found");
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe("NOT_FOUND");
    });
  });

  describe("ConflictError", () => {
    it("should create 409 error", () => {
      const error = new ConflictError("Duplicate entry");
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("CONFLICT");
    });
  });

  describe("UnprocessableEntityError", () => {
    it("should create 422 error", () => {
      const error = new UnprocessableEntityError("Invalid data");
      expect(error.statusCode).toBe(422);
      expect(error.code).toBe("UNPROCESSABLE_ENTITY");
    });
  });

  describe("InternalServerError", () => {
    it("should create 500 error", () => {
      const error = new InternalServerError("Server error");
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe("INTERNAL_ERROR");
    });

    it("should be non-operational in production", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      const error = new InternalServerError();
      expect(error.isOperational).toBe(false);
      process.env.NODE_ENV = originalEnv;
    });

    it("should be operational in development", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const error = new InternalServerError();
      expect(error.isOperational).toBe(true);
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe("ServiceUnavailableError", () => {
    it("should create 503 error", () => {
      const error = new ServiceUnavailableError("Service down");
      expect(error.statusCode).toBe(503);
      expect(error.code).toBe("SERVICE_UNAVAILABLE");
    });
  });

  describe("isAppError type guard", () => {
    it("should return true for AppError", () => {
      const error = new AppError("Test");
      expect(isAppError(error)).toBe(true);
    });

    it("should return false for regular Error", () => {
      const error = new Error("Test");
      expect(isAppError(error)).toBe(false);
    });

    it("should return false for non-error values", () => {
      expect(isAppError(null)).toBe(false);
      expect(isAppError(undefined)).toBe(false);
      expect(isAppError("string")).toBe(false);
      expect(isAppError({})).toBe(false);
    });
  });

  describe("getStatusCode", () => {
    it("should return statusCode for AppError", () => {
      const error = new BadRequestError();
      expect(getStatusCode(error)).toBe(400);
    });

    it("should return 500 for regular Error", () => {
      const error = new Error("Test");
      expect(getStatusCode(error)).toBe(500);
    });

    it("should return 500 for non-error values", () => {
      expect(getStatusCode(null)).toBe(500);
      expect(getStatusCode(undefined)).toBe(500);
      expect(getStatusCode("string")).toBe(500);
    });
  });
});

describe("Error Handling Middleware", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
  });

  describe("createErrorHandler", () => {
    it("should handle AppError with correct status code", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new BadRequestError("Invalid input");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("BAD_REQUEST");
      expect(res.body.error.message).toBe("Invalid input");
    });

    it("should handle NotFoundError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new NotFoundError("Resource not found");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("should handle UnauthorizedError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new UnauthorizedError();
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(401);
    });

    it("should handle ForbiddenError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new ForbiddenError("No access");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(403);
    });

    it("should handle ConflictError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new ConflictError("Duplicate");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(409);
    });

    it("should handle UnprocessableEntityError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new UnprocessableEntityError("Validation failed");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(422);
    });

    it("should handle InternalServerError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new InternalServerError();
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(500);
    });

    it("should handle ServiceUnavailableError", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new ServiceUnavailableError();
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(503);
    });

    it("should handle regular Error with 500 status", async () => {
      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new Error("Unexpected error");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL_ERROR");
    });

    it("should include stack trace in development", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new Error("Test error");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.body.error.stack).toBeDefined();

      process.env.NODE_ENV = originalEnv;
    });

    it("should not include stack trace in production", async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      const errorHandler = createErrorHandler();
      app.get("/test", () => {
        throw new Error("Test error");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.body.error.stack).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });

    it("should use custom unknown error message", async () => {
      const errorHandler = createErrorHandler({
        unknownErrorMessage: "Custom error message",
      });
      app.get("/test", () => {
        throw new Error("Test error");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      expect(res.body.error.message).toBe("Custom error message");
    });

    it("should call custom logError function", async () => {
      let logCalled = false;
      const errorHandler = createErrorHandler({
        logError: (_err, _req) => {
          logCalled = true;
        },
      });
      app.get("/test", () => {
        throw new Error("Test error");
      });
      app.use(errorHandler);

      await request(app).get("/test");
      expect(logCalled).toBe(true);
    });
  });

  describe("notFoundMiddleware", () => {
    it("should return 404 for unmatched routes", async () => {
      const errorHandler = createErrorHandler();
      app.use(notFoundMiddleware);
      app.use(errorHandler);

      const res = await request(app).get("/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("should include method and path in error message", async () => {
      const errorHandler = createErrorHandler();
      app.use(notFoundMiddleware);
      app.use(errorHandler);

      const res = await request(app).post("/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body.error.message).toContain("POST");
      expect(res.body.error.message).toContain("/nonexistent");
    });
  });

  describe("asyncErrorHandler", () => {
    it("should catch async errors and pass to error handler", async () => {
      const errorHandler = createErrorHandler();

      app.get(
        "/async",
        asyncErrorHandler(async () => {
          await Promise.reject(new BadRequestError("Async error"));
        }),
      );
      app.use(errorHandler);

      const res = await request(app).get("/async");
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("Async error");
    });

    it("should work with synchronous errors", async () => {
      const errorHandler = createErrorHandler();

      app.get(
        "/sync",
        asyncErrorHandler(() => {
          throw new BadRequestError("Sync error");
        }),
      );
      app.use(errorHandler);

      const res = await request(app).get("/sync");
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("Sync error");
    });

    it("should pass successful responses through", async () => {
      const errorHandler = createErrorHandler();

      app.get(
        "/success",
        asyncErrorHandler(async (_req, res) => {
          res.json({ success: true });
        }),
      );
      app.use(errorHandler);

      const res = await request(app).get("/success");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle errors thrown after response is sent", async () => {
      const errorHandler = createErrorHandler();

      app.get("/test", (_req, res) => {
        res.json({ ok: true });
        throw new Error("Error after response");
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      // Response should still be sent successfully
      expect(res.status).toBe(200);
    });

    it("should handle null error", async () => {
      const errorHandler = createErrorHandler();

      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      app.get("/test", () => {
        throw null;
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      // null thrown results in 404 because Express treats it as route not found
      expect(res.status).toBe(404);
    });

    it("should handle string error", async () => {
      const errorHandler = createErrorHandler();

      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      app.get("/test", () => {
        throw "string error";
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      // string errors are treated as 500 by our handler
      expect(res.status).toBe(500);
    });

    it("should handle non-error objects", async () => {
      const errorHandler = createErrorHandler();

      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      app.get("/test", () => {
        throw { code: "CUSTOM", message: "Not an error" };
      });
      app.use(errorHandler);

      const res = await request(app).get("/test");
      // non-error objects result in 500
      expect(res.status).toBe(500);
    });
  });
});

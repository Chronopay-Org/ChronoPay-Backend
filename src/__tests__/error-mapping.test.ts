import request from "supertest";
import express from "express";
import { errorHandler } from "../middleware/errorHandler";
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  ServiceUnavailableError,
} from "../errors/AppError";

describe("Domain error to HTTP status mapping", () => {
  const app = express();
  app.use(express.json());

  app.get("/bad-request", () => {
    throw new BadRequestError();
  });
  app.get("/unauthorized", () => {
    throw new UnauthorizedError();
  });
  app.get("/forbidden", () => {
    throw new ForbiddenError();
  });
  app.get("/not-found", () => {
    throw new NotFoundError();
  });
  app.get("/conflict", () => {
    throw new ConflictError();
  });
  app.get("/unprocessable", () => {
    throw new UnprocessableEntityError();
  });
  app.get("/service-unavailable", () => {
    throw new ServiceUnavailableError();
  });
  app.get("/internal", () => {
    throw new AppError("Internal", 500, "INTERNAL_ERROR", false);
  });
  app.get("/unknown", () => {
    throw new Error("Unknown error");
  });

  app.use(errorHandler);

  const cases = [
    ["/bad-request", 400, "BAD_REQUEST"],
    ["/unauthorized", 401, "UNAUTHORIZED"],
    ["/forbidden", 403, "FORBIDDEN"],
    ["/not-found", 404, "NOT_FOUND"],
    ["/conflict", 409, "CONFLICT"],
    ["/unprocessable", 422, "UNPROCESSABLE_ENTITY"],
    ["/service-unavailable", 503, "SERVICE_UNAVAILABLE"],
    ["/internal", 500, "INTERNAL_ERROR"],
    ["/unknown", 500, "INTERNAL_ERROR"],
  ];

  it.each(cases)("%s maps to %i/%s", async (route, status, code) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toHaveProperty("requestId");
  });
});

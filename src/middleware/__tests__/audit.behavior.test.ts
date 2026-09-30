import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

import { defaultAuditLogger } from "../../services/auditLogger.js";
import { auditMiddleware } from "../audit.js";

function responseWithStatus(statusCode: number): Response & EventEmitter {
  const response = new EventEmitter() as Response & EventEmitter;
  Object.defineProperty(response, "statusCode", { value: statusCode, writable: true });
  return response;
}

function request(overrides: Partial<Request> = {}): Request {
  return {
    method: "GET",
    originalUrl: "/resource",
    ip: "127.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
    ...overrides,
  } as Request;
}

describe("auditMiddleware focused behavior", () => {
  const logSpy = jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined);

  afterEach(() => {
    logSpy.mockClear();
  });

  it("continues immediately and waits for finish before recording the outcome", () => {
    const req = request();
    const res = responseWithStatus(204);
    const next = jest.fn() as NextFunction;

    auditMiddleware("READ_RESOURCE")(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();

    res.emit("finish");
    expect(logSpy).toHaveBeenCalledWith(
      "READ_RESOURCE",
      { method: "GET", body: undefined },
      { actorIp: "127.0.0.1", resource: "/resource", status: 204 },
    );
  });

  it("redacts nested credentials and falls back to the socket address", () => {
    const req = request({
      method: "POST",
      ip: undefined,
      originalUrl: "/resource?mode=create",
      body: {
        name: "visible",
        password: "hidden",
        nested: { apiKey: "hidden-too" },
      },
    });
    const res = responseWithStatus(201);

    auditMiddleware("CREATE_RESOURCE")(req, res, jest.fn() as NextFunction);
    res.emit("finish");

    expect(logSpy).toHaveBeenCalledWith(
      "CREATE_RESOURCE",
      {
        method: "POST",
        body: {
          name: "visible",
          password: "***REDACTED***",
          nested: { apiKey: "***REDACTED***" },
        },
      },
      { actorIp: "10.0.0.1", resource: "/resource?mode=create", status: 201 },
    );
  });

  it("keeps missing optional request data deterministic at boundary status codes", () => {
    const req = request({
      method: "DELETE",
      body: undefined,
      ip: undefined,
      socket: { remoteAddress: undefined } as Request["socket"],
      originalUrl: "",
    });
    const res = responseWithStatus(500);

    auditMiddleware("")(req, res, jest.fn() as NextFunction);
    res.emit("finish");

    expect(logSpy).toHaveBeenCalledWith(
      "",
      { method: "DELETE", body: undefined },
      { actorIp: undefined, resource: "", status: 500 },
    );
  });
});

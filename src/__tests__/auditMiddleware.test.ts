import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { auditMiddleware } from "../middleware/audit.js";
import { defaultAuditLogger } from "../services/auditLogger.js";
import { Request, Response, NextFunction } from "express";

describe("auditMiddleware", () => {
  beforeEach(() => {
    jest.spyOn(defaultAuditLogger, "log").mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should log request details on response finish", () => {
    const middleware = auditMiddleware("CREATE_ITEM");

    const req: Partial<Request> = {
      ip: "192.168.1.1",
      originalUrl: "/api/items",
      method: "POST",
      body: { name: "TestItem", password: "secret_password" },
      // Mock Express socket structure fallback if ip is undefined
      socket: { remoteAddress: "192.168.1.1" } as any,
    };

    let finishCallback: () => void;
    
    const res: Partial<Response> = {
      statusCode: 201,
      on: jest.fn((event, cb) => {
        if (event === "finish") {
          finishCallback = cb as () => void;
        }
        return res as Response;
      }),
    };

    const next: NextFunction = jest.fn();

    middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));

    // Trigger the callback that Express would call
    finishCallback!();

    expect(defaultAuditLogger.log).toHaveBeenCalledWith({
      action: "CREATE_ITEM",
      actorIp: "192.168.1.1",
      resource: "/api/items",
      status: 201,
      metadata: {
        method: "POST",
        body: { name: "TestItem", password: "***" },
      },
    });
  });
});

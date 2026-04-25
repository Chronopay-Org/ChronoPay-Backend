import { Request } from "express";

export interface RequestLogContext {
  requestId: string;
  route: string;
  method: string;
  status?: number;
  duration?: number;
  userId?: string;
  apiKeyId?: string;
  ip?: string;
  userAgent?: string;
}

export interface IdentityContext {
  userId?: string;
  apiKeyId?: string;
}

const ROUTE_PLACEHOLDER = "__route_placeholder__";

export function buildRequestLogContext(req: Request): RequestLogContext {
  const requestId = (req as any).id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const route = req.route?.path || req.path || req.originalUrl || ROUTE_PLACEHOLDER;

  return {
    requestId,
    route: sanitizeRoute(route),
    method: req.method || "UNKNOWN",
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.get("user-agent") || undefined,
  };
}

export function addIdentityToContext(
  context: RequestLogContext,
  identity: IdentityContext
): RequestLogContext {
  if (identity.userId) {
    return { ...context, userId: identity.userId };
  }
  if (identity.apiKeyId) {
    return { ...context, apiKeyId: identity.apiKeyId };
  }
  return context;
}

export function addResponseData(
  context: RequestLogContext,
  status: number,
  duration: number
): RequestLogContext {
  return {
    ...context,
    status,
    duration,
  };
}

function sanitizeRoute(route: string): string {
  return route
    .replace(/:[\w]+/g, ":REDACTED")
    .replace(/\*$/, ":WILDCARD");
}

export function extractIdentity(req: Request): IdentityContext {
  const logContext = (req as any).logContext;
  if (logContext?.userId) {
    return { userId: logContext.userId };
  }
  if (logContext?.apiKeyId) {
    return { apiKeyId: logContext.apiKeyId };
  }

  const auth = (req as any).auth;
  if (auth?.userId) {
    return { userId: auth.userId };
  }

  const apiKeyId = req.header("x-api-key-id");
  if (apiKeyId) {
    return { apiKeyId };
  }

  return {};
}
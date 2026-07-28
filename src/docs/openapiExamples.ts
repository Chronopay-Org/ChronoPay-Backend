export interface CapturedExample {
  method: string;
  path: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  statusCode?: number;
}

const examples = new Map<string, CapturedExample>();

const normalizePath = (path: string): string => {
  const withoutQuery = path.replace(/\?.*$/, "");
  const normalized = withoutQuery.replace(/\/+/g, "/");
  return normalized.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
};

const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (value.includes("@")) {
      return "[REDACTED_EMAIL]";
    }
    if (/^[a-f0-9-]{8,}$/i.test(value) || /^\d{3,}$/.test(value)) {
      return value;
    }
    if (value.length > 12) {
      return `${value.slice(0, 4)}***${value.slice(-2)}`;
    }
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        /token|secret|password|authorization|cookie|api[_-]?key/i.test(key)
          ? "[REDACTED]"
          : /email/i.test(key)
            ? "[REDACTED_EMAIL]"
            : redactValue(entryValue),
      ])
    );
  }

  return value;
};

const sanitizeBody = (body: unknown): Record<string, unknown> | undefined => {
  if (!body || typeof body === "string") {
    return undefined;
  }

  if (body && typeof body === "object") {
    return redactValue(body) as Record<string, unknown>;
  }

  return { value: redactValue(body) };
};

export const captureOpenApiExample = (args: {
  method: string;
  path: string;
  requestBody?: unknown;
  responseBody?: unknown;
  statusCode?: number;
}) => {
  const method = args.method.toLowerCase();
  const path = normalizePath(args.path);
  const key = `${method.toUpperCase()} ${path}`;

  const nextExample: CapturedExample = {
    method,
    path,
    request: sanitizeBody(args.requestBody),
    response: sanitizeBody(args.responseBody),
    statusCode: args.statusCode,
  };

  examples.set(key, nextExample);
  return nextExample;
};

export const getCapturedOpenApiExamples = () => Object.fromEntries(examples.entries());

const findMatchingPathItem = (spec: Record<string, any>, capturedPath: string) => {
  const normalizedCapturedPath = normalizePath(capturedPath);
  const exact = spec.paths?.[normalizedCapturedPath];
  if (exact) {
    return exact;
  }

  const capturedSegments = normalizedCapturedPath.split("/").filter(Boolean);
  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    const specSegments = pathKey.split("/").filter(Boolean);
    if (capturedSegments.length !== specSegments.length) {
      continue;
    }

    const matches = specSegments.every((segment, index) => {
      if (segment.startsWith("{" ) && segment.endsWith("}")) {
        return capturedSegments[index] !== undefined;
      }
      return segment === capturedSegments[index];
    });

    if (matches) {
      return pathItem;
    }
  }

  return undefined;
};

export const mergeOpenApiExamples = (spec: Record<string, any>) => {
  const cloned = JSON.parse(JSON.stringify(spec));
  const examples = getCapturedOpenApiExamples();

  for (const [routeKey, entry] of Object.entries(examples)) {
    const [method, rawPath] = routeKey.split(" ");
    const pathItem = findMatchingPathItem(cloned, rawPath);
    if (!pathItem) continue;

    const operation = pathItem[method.toLowerCase()];
    if (!operation) continue;

    if (entry.request && !operation.requestBody?.content?.["application/json"]?.example) {
      operation.requestBody = operation.requestBody || { content: {} };
      operation.requestBody.content = operation.requestBody.content || {};
      operation.requestBody.content["application/json"] = operation.requestBody.content["application/json"] || {};
      operation.requestBody.content["application/json"].example = entry.request;
    }

    if (entry.response && entry.statusCode) {
      const response = operation.responses?.[String(entry.statusCode)];
      if (response) {
        response.content = response.content || {};
        response.content["application/json"] = response.content["application/json"] || {};
        response.content["application/json"].example = entry.response;
      }
    }
  }

  return cloned;
};

export const clearCapturedOpenApiExamples = () => {
  examples.clear();
};

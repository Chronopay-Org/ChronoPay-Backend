import request from "supertest";
import { createApp } from "../../app.js";

interface IntegrationHarnessOptions {
  apiKey?: string;
}

const DEFAULT_API_KEY = "test-api-key";

export function createIntegrationHarness(options: IntegrationHarnessOptions = {}) {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const app = createApp({
    apiKey,
    enableDocs: false,
    enableTestRoutes: true,
  });

  return {
    app,
    apiKey,
    request: request(app),
    authorizedPost: (path: string) => request(app).post(path).set("x-api-key", apiKey),
  };
}

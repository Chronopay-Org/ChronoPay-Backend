import { jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";

describe("registerSwaggerDocs behavior", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    // cleanup possible dist created by tests
    try {
      fs.rmSync(path.join(process.cwd(), "dist"), { recursive: true, force: true });
    } catch (_) {}
  });

  it("points apis at dist when compiled files exist", async () => {
    // create a fake dist/routes file to simulate a compiled build
    const distRoutesDir = path.join(process.cwd(), "dist", "routes");
    fs.mkdirSync(distRoutesDir, { recursive: true });
    fs.writeFileSync(path.join(distRoutesDir, "dummy.js"), "// compiled route");

    let capturedOptions: any = null;

    jest.mock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "swagger-jsdoc") {
          return (opts: any) => {
            capturedOptions = opts;
            return { openapi: "3.0.0" };
          };
        }
        if (id === "swagger-ui-express") {
          return { serve: () => {}, setup: () => {} };
        }
        // fallback to real require for other modules
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(id);
      },
    }));

    const { createApp } = await import("../app.js");
    const app = createApp({ enableDocs: true });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.apis).toContain("./dist/routes/*.js");

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("points apis at src when no compiled files exist", async () => {
    // ensure no dist exists
    try {
      fs.rmSync(path.join(process.cwd(), "dist"), { recursive: true, force: true });
    } catch (_) {}

    let capturedOptions: any = null;

    jest.mock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "swagger-jsdoc") {
          return (opts: any) => {
            capturedOptions = opts;
            return { openapi: "3.0.0" };
          };
        }
        if (id === "swagger-ui-express") {
          return { serve: () => {}, setup: () => {} };
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(id);
      },
    }));

    const { createApp } = await import("../app.js");
    const app = createApp({ enableDocs: true });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.apis).toContain("./src/routes/*.ts");

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("memoizes generated spec across repeated app creation", async () => {
    let callCount = 0;

    jest.mock("node:module", () => ({
      createRequire: () => (id: string) => {
        if (id === "swagger-jsdoc") {
          return (_opts: any) => {
            callCount += 1;
            return { openapi: "3.0.0" };
          };
        }
        if (id === "swagger-ui-express") {
          return { serve: () => {}, setup: () => {} };
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(id);
      },
    }));

    const { createApp } = await import("../app.js");

    const app1 = createApp({ enableDocs: true });
    const app2 = createApp({ enableDocs: true });

    expect(callCount).toBe(1);

    const res = await request(app2).get("/health");
    expect(res.status).toBe(200);
  });
});

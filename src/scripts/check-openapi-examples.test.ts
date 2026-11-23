import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  checkOpenApiExamples,
  runCheckOpenApiExamples,
} from "./check-openapi-examples.js";

const tempDirs: string[] = [];

function writeSpec(spec: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapi-examples-"));
  tempDirs.push(dir);
  const outputPath = path.join(dir, "openapi-spec.json");
  writeFileSync(outputPath, JSON.stringify(spec), "utf8");
  return outputPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkOpenApiExamples", () => {
  test("returns exit code 1 when the snapshot is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "openapi-examples-missing-"));
    tempDirs.push(dir);
    const outputPath = path.join(dir, "openapi-spec.json");

    const result = checkOpenApiExamples({ outputPath });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("OpenAPI spec snapshot missing");
  });

  test("returns exit code 1 and names a route without a success example", () => {
    const outputPath = writeSpec({
      openapi: "3.0.0",
      paths: {
        "/api/v1/users": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {},
                },
              },
            },
          },
        },
      },
    });

    const result = checkOpenApiExamples({ outputPath });

    expect(result.exitCode).toBe(1);
    expect(result.lines).toContain("- GET /api/v1/users");
  });

  test("returns exit code 0 when every route has a success example", () => {
    const outputPath = writeSpec({
      openapi: "3.0.0",
      paths: {
        "/api/v1/users": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    example: { users: [] },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result = runCheckOpenApiExamples({ outputPath });

    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("1 routes");
  });
});

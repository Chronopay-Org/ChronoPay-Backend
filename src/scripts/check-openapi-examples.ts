import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeOpenApiExamples } from "../docs/openapiExamples.js";

export interface ScriptResult {
  exitCode: number;
  lines: string[];
}

export interface CheckOpenApiExamplesOptions {
  outputPath?: string;
  mergeExamples?: (spec: Record<string, any>) => Record<string, any>;
  writeLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export function checkOpenApiExamples(
  options: CheckOpenApiExamplesOptions = {},
): ScriptResult {
  const outputPath =
    options.outputPath ??
    path.resolve(process.cwd(), "openapi-spec.json");

  const finish = (exitCode: number, lines: string[]): ScriptResult => {
    if (options.writeLine) {
      const stream = exitCode === 0 ? "stdout" : "stderr";
      for (const line of lines) {
        options.writeLine(line, stream);
      }
    }
    return { exitCode, lines };
  };

  if (!existsSync(outputPath)) {
    return finish(1, [
      "OpenAPI spec snapshot missing. Run npm run generate-openapi first.",
    ]);
  }

  let spec: Record<string, any>;
  try {
    spec = JSON.parse(readFileSync(outputPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(1, [
      `Unable to read OpenAPI spec snapshot: ${message}`,
    ]);
  }
  const merged = (options.mergeExamples ?? mergeOpenApiExamples)(spec);
  const missingExamples: string[] = [];

  for (const [routePath, pathItem] of Object.entries(merged.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem as Record<string, any>)) {
      if (!["get", "post", "put", "delete", "patch"].includes(method.toLowerCase())) continue;
      const responses = operation.responses || {};
      const hasSuccessExample = Object.entries(responses).some(([_statusCode, response]: [string, any]) => {
        if (typeof response !== "object" || !response.content?.["application/json"]) return false;
        return Boolean(response.content["application/json"].example);
      });

      if (!hasSuccessExample) {
        missingExamples.push(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  if (missingExamples.length > 0) {
    return finish(1, [
      "OpenAPI examples missing for routes:",
      ...missingExamples.map((route) => `- ${route}`),
    ]);
  }

  return finish(0, [
    `OpenAPI examples verified for ${Object.keys(merged.paths || {}).length} routes.`,
  ]);
}

export const runCheckOpenApiExamples = checkOpenApiExamples;

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = checkOpenApiExamples();
  const writer = result.exitCode === 0 ? console.log : console.error;
  for (const line of result.lines) {
    writer(line);
  }
  process.exit(result.exitCode);
}

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { mergeOpenApiExamples } from "../docs/openapiExamples.js";

const outputPath = path.resolve(process.cwd(), "openapi-spec.json");
if (!existsSync(outputPath)) {
  console.error("OpenAPI spec snapshot missing. Run npm run generate-openapi first.");
  process.exit(1);
}

const spec = JSON.parse(readFileSync(outputPath, "utf-8"));
const merged = mergeOpenApiExamples(spec);
const missingExamples: string[] = [];

for (const [routePath, pathItem] of Object.entries((merged as any).paths || {})) {
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
  console.error("OpenAPI examples missing for routes:");
  for (const route of missingExamples) {
    console.error(`- ${route}`);
  }
  process.exit(1);
}

console.log(`OpenAPI examples verified for ${Object.keys((merged as any).paths || {}).length} routes.`);

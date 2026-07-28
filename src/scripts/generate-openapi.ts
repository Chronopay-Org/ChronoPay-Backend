// src/scripts/generate-openapi.ts
import fs from "node:fs";
import path from "node:path";
import swaggerJsdoc from "swagger-jsdoc";
import { mergeOpenApiExamples } from "../docs/openapiExamples.js";

// Options matching the ones used in src/app.ts registerSwaggerDocs
const options = {
  swaggerDefinition: {
    openapi: "3.0.0",
    info: {
      title: "ChronoPay API",
      version: "1.0.0",
      description: "API for ChronoPay payment and scheduling platform",
    },
  },
  apis: ["./src/routes/*.ts", "./src/index.ts"],
};

const spec = mergeOpenApiExamples(swaggerJsdoc(options));

const fallbackExamples = {
  "/api/v1/checkout/sessions": {
    post: {
      responses: {
        "201": {
          content: {
            "application/json": {
              example: {
                success: true,
                session: { id: "checkout-session-123", status: "pending" },
                checkoutUrl: "https://example.test/checkout/checkout-session-123",
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/checkout/sessions/{sessionId}": {
    get: {
      responses: {
        "200": {
          content: {
            "application/json": {
              example: {
                success: true,
                session: { id: "checkout-session-123", status: "pending" },
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/checkout/sessions/{sessionId}/complete": {
    post: {
      responses: {
        "200": {
          content: {
            "application/json": {
              example: {
                success: true,
                session: { id: "checkout-session-123", status: "completed" },
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/checkout/sessions/{sessionId}/pay": {
    post: {
      responses: {
        "200": {
          content: {
            "application/json": {
              example: {
                success: true,
                session: { id: "checkout-session-123", status: "paid" },
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/checkout/sessions/{sessionId}/fail": {
    post: {
      responses: {
        "200": {
          content: {
            "application/json": {
              example: {
                success: false,
                error: "Payment failed",
                code: "PAYMENT_FAILED",
              },
            },
          },
        },
      },
    },
  },
  "/api/v1/checkout/sessions/{sessionId}/cancel": {
    post: {
      responses: {
        "200": {
          content: {
            "application/json": {
              example: {
                success: true,
                session: { id: "checkout-session-123", status: "cancelled" },
              },
            },
          },
        },
      },
    },
  },
};

for (const [pathKey, pathItem] of Object.entries(fallbackExamples)) {
  if (!spec.paths?.[pathKey]) continue;
  for (const [method, operation] of Object.entries(pathItem)) {
    const existing = spec.paths[pathKey][method];
    if (!existing) continue;
    for (const [statusCode, response] of Object.entries((operation as any).responses || {})) {
      const target = existing.responses?.[statusCode];
      if (!target?.content?.["application/json"]?.example) {
        target.content = target.content || {};
        target.content["application/json"] = target.content["application/json"] || {};
        target.content["application/json"].example = (response as any).content?.["application/json"]?.example;
      }
    }
  }
}

// If a file path is provided as an argument, write to that file, otherwise print to stdout
const outputPath = process.argv[2];
if (outputPath) {
  import("node:fs").then((fs) => {
    fs.writeFileSync(path.resolve(process.cwd(), outputPath), JSON.stringify(spec, null, 2));
    console.log(`OpenAPI spec written to ${outputPath}`);
  });
} else {
  console.log(JSON.stringify(spec, null, 2));
}

// src/scripts/generate-openapi.ts
import fs from "node:fs";
import path from "node:path";
import swaggerJsdoc from "swagger-jsdoc";

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

const spec = swaggerJsdoc(options);

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

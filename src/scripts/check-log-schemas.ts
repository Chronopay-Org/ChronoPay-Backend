import { collectLogSchemaDrift, getLogSchemaRegistry } from "../utils/logSchemaRegistry.js";

const registry = getLogSchemaRegistry();
const drift = collectLogSchemaDrift();

if (drift.length > 0) {
  console.error("Structured log schema drift detected:");
  for (const issue of drift) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Structured log schema registry validated (${Object.keys(registry).length} event schemas).`);

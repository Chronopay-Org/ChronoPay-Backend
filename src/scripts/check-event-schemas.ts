#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadEventSchemaRegistry, compareEventSchemaRegistries, collectEventSchemaDeprecationWarnings, EventSchemaRegistry } from "../utils/eventSchemaRegistry.js";

interface Args {
  base?: string;
  head?: string;
}

const args = process.argv.slice(2);
const parsed: Args = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--base") {
    parsed.base = args[i + 1];
    i += 1;
  } else if (arg === "--head") {
    parsed.head = args[i + 1];
    i += 1;
  }
}

const basePath = parsed.base ?? path.resolve(process.cwd(), "docs", "event-schema.json");
const headPath = parsed.head ?? path.resolve(process.cwd(), "docs", "event-schema.json");

let baseRegistry: EventSchemaRegistry;
let headRegistry: EventSchemaRegistry;

try {
  baseRegistry = loadEventSchemaRegistry(basePath);
} catch (error) {
  console.error(`Failed to load base event schema registry from ${basePath}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

try {
  headRegistry = loadEventSchemaRegistry(headPath);
} catch (error) {
  console.error(`Failed to load head event schema registry from ${headPath}:`, error instanceof Error ? error.message : error);
  process.exit(1);
}

const compatErrors = compareEventSchemaRegistries(baseRegistry, headRegistry);
const deprecationWarnings = collectEventSchemaDeprecationWarnings(headRegistry);

if (deprecationWarnings.length > 0) {
  console.warn("Event schema deprecation warnings:");
  for (const warning of deprecationWarnings) {
    console.warn(`- ${warning}`);
  }
}

if (compatErrors.length > 0) {
  console.error("Event schema compatibility validation failed:");
  for (const error of compatErrors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Event schema registry validated: ${Object.keys(headRegistry.events).length} events loaded.`);
process.exit(0);

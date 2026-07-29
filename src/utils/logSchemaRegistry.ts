// @ts-nocheck
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";

export interface LogSchemaRegistry {
  [eventName: string]: {
    title: string;
    type: string;
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
}

const schemaPath = resolve(process.cwd(), "docs", "log-schema.json");
const schemaFile = JSON.parse(readFileSync(schemaPath, "utf-8"));
const registry = (schemaFile.registry ?? {}) as LogSchemaRegistry;

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

const ensureValidator = (eventName: string) => {
  if (validators.has(eventName)) {
    return validators.get(eventName)!;
  }

  const schema = registry[eventName];
  if (!schema) {
    throw new Error(`No schema registered for log event: ${eventName}`);
  }

  const validator = ajv.compile(schema);
  validators.set(eventName, validator);
  return validator;
};

export const getLogSchemaRegistry = (): LogSchemaRegistry => registry;

export const collectLogSchemaDrift = (): string[] => {
  const drift: string[] = [];
  const documented = Object.keys(registry).sort();
  const emitted = ["http_request", "db_operation", "external_call", "security_event"].sort();

  for (const eventName of emitted) {
    if (!documented.includes(eventName)) {
      drift.push(`Missing schema documentation for event: ${eventName}`);
    }
  }

  return drift;
};

export const validateLogEvent = (eventName: string, log: unknown): boolean => {
  const validator = ensureValidator(eventName);
  return validator(log) as boolean;
};

export const getLogEventValidatorErrors = (eventName: string) => {
  const validator = ensureValidator(eventName);
  return validator.errors;
};

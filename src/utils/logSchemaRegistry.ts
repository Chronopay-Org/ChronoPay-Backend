import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats, { type FormatsPlugin } from "ajv-formats";

export const EMITTED_LOG_EVENTS = [
  "http_request",
  "db_operation",
  "external_call",
  "security_event",
] as const;

export type EmittedLogEvent = (typeof EMITTED_LOG_EVENTS)[number];

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
const schemaFile: { registry?: LogSchemaRegistry } = JSON.parse(readFileSync(schemaPath, "utf-8"));
const registry: LogSchemaRegistry = schemaFile.registry ?? {};

const ajv = new Ajv({ allErrors: true, strict: false });
const addFormatsPlugin = addFormats as unknown as FormatsPlugin;
addFormatsPlugin(ajv);
const validators = new Map<EmittedLogEvent, ValidateFunction>();

const ensureValidator = (eventName: EmittedLogEvent): ValidateFunction => {
  const cached = validators.get(eventName);
  if (cached) {
    return cached;
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

export const collectLogSchemaDrift = (
  emittedEvents: readonly string[] = EMITTED_LOG_EVENTS
): string[] => {
  const drift: string[] = [];
  const documented = Object.keys(registry).sort();

  for (const eventName of [...emittedEvents].sort()) {
    if (!documented.includes(eventName)) {
      drift.push(`Missing schema documentation for event: ${eventName}`);
    }
  }

  return drift;
};

export const validateLogEvent = (eventName: EmittedLogEvent, log: unknown): boolean => {
  const validator = ensureValidator(eventName);
  return validator(log);
};

export const getLogEventValidatorErrors = (eventName: EmittedLogEvent) => {
  const validator = ensureValidator(eventName);
  return validator.errors;
};

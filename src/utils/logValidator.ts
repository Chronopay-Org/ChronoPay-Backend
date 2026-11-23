// @ts-nocheck
// src/utils/logValidator.ts
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLogEventValidatorErrors as getLogEventValidatorErrorsFromRegistry, validateLogEvent } from "./logSchemaRegistry.js";

// Load JSON schema from docs folder
const schemaPath = resolve(process.cwd(), "docs", "log-schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export const validateLog = (log: unknown): boolean => {
  const result = validate(log);
  return result as boolean;
};

export const getLogValidatorErrors = () => validate.errors;

export const validateLogEventWithSchema = (eventName: string, log: unknown): boolean => validateLogEvent(eventName, log);
export const getLogEventValidatorErrors = (eventName: string) => getLogEventValidatorErrorsFromRegistry(eventName);
export { validateLogEvent, getLogEventValidatorErrors as getLogEventValidatorErrorsFromRegistry } from "./logSchemaRegistry.js";

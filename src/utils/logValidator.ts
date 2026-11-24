// src/utils/logValidator.ts
import { Ajv } from "ajv";
import addFormats, { type FormatsPlugin } from "ajv-formats";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getLogEventValidatorErrors as getLogEventValidatorErrorsFromRegistry,
  validateLogEvent,
  type EmittedLogEvent,
} from "./logSchemaRegistry.js";

// Load JSON schema from docs folder
const schemaPath = resolve(process.cwd(), "docs", "log-schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
const addFormatsPlugin = addFormats as unknown as FormatsPlugin;
addFormatsPlugin(ajv);
const validate = ajv.compile(schema);

export const validateLog = (log: unknown): boolean => validate(log);

export const getLogValidatorErrors = () => validate.errors;

export const validateLogEventWithSchema = (eventName: EmittedLogEvent, log: unknown): boolean => validateLogEvent(eventName, log);
export const getLogEventValidatorErrors = (eventName: EmittedLogEvent) => getLogEventValidatorErrorsFromRegistry(eventName);
export { validateLogEvent, getLogEventValidatorErrors as getLogEventValidatorErrorsFromRegistry } from "./logSchemaRegistry.js";

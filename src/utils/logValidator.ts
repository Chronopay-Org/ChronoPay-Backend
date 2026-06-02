// src/utils/logValidator.ts
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load JSON schema from docs folder
const schemaPath = resolve(process.cwd(), "docs", "log-schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export const validateLog = (log: unknown): boolean => {
  const result = validate(log);
  return result as boolean;
};

export const getLogValidatorErrors = () => validate.errors;

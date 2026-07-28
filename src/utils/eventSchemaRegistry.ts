import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";

export interface EventSchemaVersion {
  version: string;
  deprecated?: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface EventSchemaDefinition {
  title: string;
  description?: string;
  versions: EventSchemaVersion[];
}

export interface EventSchemaRegistry {
  events: Record<string, EventSchemaDefinition>;
}

const registrySchema = {
  type: "object",
  properties: {
    events: {
      type: "object",
      patternProperties: {
        "^[a-zA-Z0-9_.:-]+$": {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            versions: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  version: { type: "string" },
                  deprecated: { type: "boolean" },
                  description: { type: "string" },
                  schema: { type: "object" },
                },
                required: ["version", "schema"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "versions"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ["events"],
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateRegistrySchema = ajv.compile(registrySchema);

export function validateEventSchemaRegistry(registry: unknown): void {
  const valid = validateRegistrySchema(registry);
  if (!valid) {
    const message = (validateRegistrySchema.errors ?? [])
      .map((error) => `${error.instancePath} ${error.message}`.trim())
      .join("; ");
    throw new Error(`Invalid event schema registry: ${message}`);
  }

  const typedRegistry = registry as EventSchemaRegistry;
  for (const [eventName, eventDefinition] of Object.entries(typedRegistry.events)) {
    const seenVersions = new Set<string>();
    for (const version of eventDefinition.versions) {
      if (seenVersions.has(version.version)) {
        throw new Error(`Duplicate version ${version.version} in event ${eventName}`);
      }
      seenVersions.add(version.version);
    }
  }
}

export function loadEventSchemaRegistry(filePath?: string): EventSchemaRegistry {
  const registryPath = filePath ?? resolve(process.cwd(), "docs", "event-schema.json");
  const raw = readFileSync(registryPath, "utf-8");
  const parsed = JSON.parse(raw);
  validateEventSchemaRegistry(parsed);
  return parsed as EventSchemaRegistry;
}

export function compareEventSchemaRegistries(
  base: EventSchemaRegistry,
  head: EventSchemaRegistry,
): string[] {
  const errors: string[] = [];

  const baseEvents = Object.keys(base.events).sort();
  const headEvents = Object.keys(head.events).sort();

  for (const eventName of baseEvents) {
    if (!headEvents.includes(eventName)) {
      errors.push(`Removed event from registry: ${eventName}`);
    }
  }

  for (const eventName of headEvents) {
    const headEvent = head.events[eventName];
    const baseEvent = base.events[eventName];

    if (!baseEvent) {
      continue;
    }

    const baseVersionMap = new Map(baseEvent.versions.map((version) => [version.version, version]));
    const headVersionMap = new Map(headEvent.versions.map((version) => [version.version, version]));

    for (const [version, baseVersion] of baseVersionMap.entries()) {
      const headVersion = headVersionMap.get(version);
      if (!headVersion) {
        errors.push(`Removed version ${version} from event ${eventName}`);
        continue;
      }
      if (!isDeepEqual(baseVersion, headVersion)) {
        errors.push(`Immutable event version modified: ${eventName}@${version}`);
      }
    }

    const newVersions = headEvent.versions.filter((version) => !baseVersionMap.has(version.version));
    const mergedVersions = [...baseEvent.versions, ...newVersions].sort((a, b) => compareSemver(a.version, b.version));

    for (const version of newVersions.sort((a, b) => compareSemver(a.version, b.version))) {
      const index = mergedVersions.findIndex((entry) => entry.version === version.version);
      if (index === -1 || index === 0) {
        continue;
      }
      const previousVersion = mergedVersions[index - 1];
      errors.push(...compareEventSchemas(eventName, previousVersion.schema, version.schema, `${eventName}@${version.version}`));
    }
  }

  return errors;
}

export function collectEventSchemaDeprecationWarnings(registry: EventSchemaRegistry): string[] {
  const warnings: string[] = [];
  for (const [eventName, eventDefinition] of Object.entries(registry.events)) {
    for (const version of eventDefinition.versions) {
      if (version.deprecated) {
        warnings.push(`Deprecated version present: ${eventName}@${version.version}`);
      }
    }
  }
  return warnings;
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string) => value.split(".").map((segment) => Number(segment));
  const aParts = parse(a);
  const bParts = parse(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const aPart = aParts[i] ?? 0;
    const bPart = bParts[i] ?? 0;
    if (aPart < bPart) return -1;
    if (aPart > bPart) return 1;
  }

  return 0;
}

function compareEventSchemas(
  eventName: string,
  baseSchema: Record<string, unknown>,
  headSchema: Record<string, unknown>,
  path: string,
): string[] {
  const errors: string[] = [];

  if (baseSchema.type !== headSchema.type) {
    errors.push(`${path}: type changed from ${baseSchema.type ?? "unknown"} to ${headSchema.type ?? "unknown"}`);
    return errors;
  }

  if (!isArraySubset(baseSchema.enum, headSchema.enum)) {
    errors.push(`${path}: enum values were narrowed or removed`);
  }

  if (baseSchema.const !== undefined && !isDeepEqual(baseSchema.const, headSchema.const)) {
    errors.push(`${path}: const value changed from ${JSON.stringify(baseSchema.const)} to ${JSON.stringify(headSchema.const)}`);
  }

  if (baseSchema.type === "object") {
    errors.push(...compareObjectSchemas(eventName, baseSchema, headSchema, path));
  }

  if (baseSchema.type === "array") {
    const baseItems = baseSchema.items as Record<string, unknown> | undefined;
    const headItems = headSchema.items as Record<string, unknown> | undefined;
    if (baseItems && headItems) {
      errors.push(...compareEventSchemas(eventName, baseItems, headItems, `${path}.items`));
    }
  }

  return errors;
}

function compareObjectSchemas(
  eventName: string,
  baseSchema: Record<string, unknown>,
  headSchema: Record<string, unknown>,
  path: string,
): string[] {
  const errors: string[] = [];
  const baseProperties = (baseSchema.properties ?? {}) as Record<string, unknown>;
  const headProperties = (headSchema.properties ?? {}) as Record<string, unknown>;
  const baseRequired = new Set<string>(Array.isArray(baseSchema.required) ? (baseSchema.required as string[]) : []);
  const headRequired = new Set<string>(Array.isArray(headSchema.required) ? (headSchema.required as string[]) : []);

  for (const [propertyName, propertySchema] of Object.entries(baseProperties)) {
    if (!Object.prototype.hasOwnProperty.call(headProperties, propertyName)) {
      errors.push(`${path}: removed property ${propertyName}`);
      continue;
    }

    const nextPropertySchema = headProperties[propertyName] as Record<string, unknown>;
    errors.push(...compareEventSchemas(eventName, propertySchema as Record<string, unknown>, nextPropertySchema, `${path}.properties.${propertyName}`));
  }

  for (const requiredField of headRequired) {
    if (!Object.prototype.hasOwnProperty.call(baseProperties, requiredField)) {
      errors.push(`${path}: added required field ${requiredField}`);
      continue;
    }

    if (!baseRequired.has(requiredField)) {
      errors.push(`${path}: field ${requiredField} became required`);
    }
  }

  const baseAdditionalProperties = baseSchema.additionalProperties;
  const headAdditionalProperties = headSchema.additionalProperties;
  if (baseAdditionalProperties !== false && headAdditionalProperties === false) {
    errors.push(`${path}: additionalProperties became restricted`);
  }

  return errors;
}

function isArraySubset(baseEnum: unknown, headEnum: unknown): boolean {
  if (!Array.isArray(baseEnum)) {
    return true;
  }
  if (!Array.isArray(headEnum)) {
    return false;
  }
  return (baseEnum as unknown[]).every((item) => (headEnum as unknown[]).some((target) => isDeepEqual(item, target)));
}

function isDeepEqual(valueA: unknown, valueB: unknown): boolean {
  if (Object.is(valueA, valueB)) {
    return true;
  }

  if (typeof valueA !== typeof valueB) {
    return false;
  }

  if (Array.isArray(valueA) && Array.isArray(valueB)) {
    if (valueA.length !== valueB.length) {
      return false;
    }
    return valueA.every((item, index) => isDeepEqual(item, valueB[index]));
  }

  if (isPlainObject(valueA) && isPlainObject(valueB)) {
    const aKeys = Object.keys(valueA as Record<string, unknown>);
    const bKeys = Object.keys(valueB as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => isDeepEqual((valueA as Record<string, unknown>)[key], (valueB as Record<string, unknown>)[key]));
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

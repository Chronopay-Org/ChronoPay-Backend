import { AuditLogger } from "../services/auditLogger.js";

export interface RedactionPolicy {
  readonly version: number;
  readonly fields: ReadonlySet<string>;
  readonly updatedAt: string;
}

interface PolicyRingEntry {
  policy: RedactionPolicy;
  swappedAt: string;
}

const MAX_ROLLBACK_ENTRIES = 5;

let currentPolicy: RedactionPolicy = createDefaultPolicy();
const rollbackBuffer: PolicyRingEntry[] = [];
const auditLogger = new AuditLogger();

function createDefaultPolicy(): RedactionPolicy {
  return Object.freeze({
    version: 1,
    fields: Object.freeze(new Set([
      "password", "secret", "token", "apikey", "api_key", "authorization",
      "cookie", "session", "privatekey", "private_key", "accesstoken",
      "access_token", "refreshtoken", "refresh_token", "bearer", "x-api-key",
      "api-key", "app_secret", "appsecret", "client_secret", "clientsecret",
      "signing_key", "signingkey", "hmac", "jwt", "aws_secret", "awssecret",
      "database_url", "databaseurl", "db_password", "dbpassword",
      "encryption_key", "encryptionkey", "webhook_secret", "webhooksecret",
      "oauth_token", "oauthtoken", "auth_code", "authcode", "cardtoken",
      "card_token", "tracking_token", "trackingtoken",
    ])) as ReadonlySet<string>,
    updatedAt: new Date().toISOString(),
  });
}

function validatePolicyInput(input: unknown): { valid: true; fields: string[] } | { valid: false; error: string } {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Policy must be a non-null object" };
  }

  const obj = input as Record<string, unknown>;

  if (!Array.isArray(obj.fields)) {
    return { valid: false, error: "Policy must contain a 'fields' array" };
  }

  if (obj.fields.length === 0) {
    return { valid: false, error: "Fields array must not be empty" };
  }

  const fields: string[] = [];
  for (const field of obj.fields) {
    if (typeof field !== "string") {
      return { valid: false, error: `All fields must be strings, got ${typeof field}` };
    }
    const trimmed = field.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: "Field names must not be empty strings" };
    }
    if (trimmed.length > 128) {
      return { valid: false, error: `Field name too long: "${trimmed.slice(0, 32)}..."` };
    }
    fields.push(trimmed.toLowerCase());
  }

  return { valid: true, fields: [...new Set(fields)] };
}

export function getCurrentPolicy(): RedactionPolicy {
  return currentPolicy;
}

export function getCurrentPolicyVersion(): number {
  return currentPolicy.version;
}

export function isFieldRedacted(fieldName: string): boolean {
  return currentPolicy.fields.has(fieldName.toLowerCase());
}

export function getPolicyFields(): string[] {
  return Array.from(currentPolicy.fields);
}

export function swapPolicy(
  input: unknown,
  actorIp?: string,
): { success: true; policy: RedactionPolicy } | { success: false; error: string } {
  const validation = validatePolicyInput(input);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const oldVersion = currentPolicy.version;
  const newVersion = oldVersion + 1;
  const now = new Date().toISOString();

  const newPolicy: RedactionPolicy = Object.freeze({
    version: newVersion,
    fields: Object.freeze(new Set(validation.fields)) as ReadonlySet<string>,
    updatedAt: now,
  });

  const entry: PolicyRingEntry = { policy: currentPolicy, swappedAt: now };
  rollbackBuffer.unshift(entry);
  if (rollbackBuffer.length > MAX_ROLLBACK_ENTRIES) {
    rollbackBuffer.pop();
  }

  currentPolicy = newPolicy;

  auditLogger.log(
    "policy.reload.succeeded",
    {
      method: "POST",
      context: {
        oldVersion,
        newVersion,
        fieldCount: validation.fields.length,
        fields: validation.fields,
      },
    },
    {
      actorIp,
      resource: "/api/v1/admin/redaction-policy/reload",
      status: 200,
    },
  );

  return { success: true, policy: newPolicy };
}

export function rollbackPolicy(
  actorIp?: string,
): { success: true; policy: RedactionPolicy } | { success: false; error: string } {
  if (rollbackBuffer.length === 0) {
    return { success: false, error: "No previous policy version available for rollback" };
  }

  const entry = rollbackBuffer.shift()!;
  const oldVersion = currentPolicy.version;
  const _now = new Date().toISOString();

  currentPolicy = entry.policy;

  auditLogger.log(
    "policy.reload.rollback",
    {
      method: "POST",
      context: {
        oldVersion,
        newVersion: entry.policy.version,
        rolledBackTo: entry.policy.version,
      },
    },
    {
      actorIp,
      resource: "/api/v1/admin/redaction-policy/rollback",
      status: 200,
    },
  );

  return { success: true, policy: currentPolicy };
}

export function getRollbackHistory(): Array<{ version: number; swappedAt: string }> {
  return rollbackBuffer.map((e) => ({ version: e.policy.version, swappedAt: e.swappedAt }));
}

export function _resetPolicyForTesting(): void {
  currentPolicy = createDefaultPolicy();
  rollbackBuffer.length = 0;
}

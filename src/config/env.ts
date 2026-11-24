import os from "os";

export type NodeEnv = "development" | "test" | "production";
export type QuotaFailMode = "open" | "closed";

export interface EncryptionKey {
  id: string;
  value: Buffer;
}

export type IdempotencyRedisEncryptionConfig =
  | {
      enabled: false;
      algorithm: "aes-256-gcm";
      activeKey: null;
      decryptionKeys: readonly EncryptionKey[];
    }
  | {
      enabled: true;
      algorithm: "aes-256-gcm";
      activeKey: EncryptionKey;
      decryptionKeys: readonly EncryptionKey[];
    };

export interface TreasuryFloorConfig {
  asset: string;
  floor: number;
  hysteresis?: number;
}

export interface EnvConfig {
  nodeEnv: NodeEnv;
  port: number;
  redisUrl: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  quotaFailMode: QuotaFailMode;
  trustProxy: boolean;
  /**
   * Explicit opt-in for test-only routes (e.g. /__test__/explode, /api/v1/test/auth).
   * Always false unless ENABLE_TEST_ROUTES is set to a truthy value.
   */
  enableTestRoutes: boolean;
  timeoutMs?: number;
  webhookSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  corsAllowedOrigins: readonly string[];
  /** Stellar Horizon base URLs (comma-separated, first is primary) */
  horizonUrls?: string[];
  /** Stellar network passphrase used to identify the target network */
  networkPassphrase?: string;
  /** Pinned hash for the current active escrow contract */
  escrowContractHash?: string;
  /** Public base URL for generating download links (GDPR/audit exports). */
  appUrl?: string;
  /** Secret used to verify the internal fair-queue rate-limit bypass HMAC signature. */
  internalOverrideSecret?: string;
  /** Previous secret for zero-downtime rotation of the bypass signing key. */
  internalOverrideSecretPrev?: string;
  /** Acceptable clock skew (ms) for the bypass timestamp. Default 30 000. */
  internalBypassToleranceMs: number;
  /** Issuer label embedded in TOTP otpauth URIs and QR code labels. */
  mfaIssuer?: string;
  /** Max age (ms) of an MFA Challenge before `requireFreshMfa` rejects it. Default 15 min. */
  mfaFreshnessMs: number;
  /** Clock-skew windows accepted around the current TOTP step on verification. Default 1. */
  mfaWindowPeriods: number;
  /** Lifetime (seconds) of an issued MFA challenge token. Default 300. */
  mfaChallengeTtlSec: number;
  /**
   * Require a fresh MFA challenge on customer booking refunds.
   * Default: enabled when NODE_ENV=production, disabled otherwise.
   */
  mfaRequiredForRefunds: boolean;
  /**
   * Static bearer token required to scrape /metrics. When unset, /metrics is
   * unauthenticated outside production.
   */
  metricsAuthToken?: string;
  /**
   * Explicit opt-out allowing an unauthenticated /metrics endpoint in production.
   * Must be set to true when METRICS_AUTH_TOKEN is not configured in production.
   */
  metricsPublic: boolean;
  /**
   * Optional AES-256-GCM encryption of idempotency payloads stored in Redis.
   * See docs/security/redis-encryption.md. Disabled unless
   * IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED is truthy.
   */
  idempotencyRedisEncryption: IdempotencyRedisEncryptionConfig;
   * When true, honour `x-region` and `x-data-region` headers if the request
   * also supplies a valid `x-edge-secret` matching `RESIDENCY_EDGE_SECRET`.
   * Default: false (both headers are ignored).
   */
  residencyTrustRegionHeaders: boolean;
  /**
   * Shared secret expected in `x-edge-secret` when `RESIDENCY_TRUST_REGION_HEADERS`
   * is enabled. Compared using constant-time equality.
   */
  residencyEdgeSecret?: string;
  /** Comma-separated Stellar treasury account IDs to poll on Horizon. */
  treasuryAccounts: readonly string[];
  /** Per-asset floor thresholds parsed from TREASURY_FLOORS_JSON. */
  treasuryFloors: readonly TreasuryFloorConfig[];
  /** Polling interval (ms) for the treasury balance poller. Default 30 000. */
  treasuryPollIntervalMs: number;
  /** Max age (ms) before treasury balance readings are considered stale. Default 120 000. */
  treasuryMaxStalenessMs: number;
}

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const issues: string[] = [];

  const nodeEnv = parseNodeEnv(env.NODE_ENV, issues);
  const port = parsePort(env.PORT, issues);
  const redisUrl = parseRedisUrl(env.REDIS_URL, issues);

  const timeoutMs = parsePositiveInteger(env.REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT_MS", 30_000, issues);
  const rateLimitWindowMs = parsePositiveInteger(
    env.RATE_LIMIT_WINDOW_MS,
    "RATE_LIMIT_WINDOW_MS",
    15 * 60 * 1000,
    issues,
  );
  const rateLimitMax = parsePositiveInteger(env.RATE_LIMIT_MAX, "RATE_LIMIT_MAX", 100, issues);
  const quotaFailMode = parseQuotaFailMode(env.QUOTA_FAIL_MODE, issues);
  const trustProxy = parseBoolean(env.TRUST_PROXY, "TRUST_PROXY", false, issues);
  const enableTestRoutes = parseBoolean(
    env.ENABLE_TEST_ROUTES,
    "ENABLE_TEST_ROUTES",
    false,
    issues,
  );

  const webhookSecret = parseOptionalString(env.WEBHOOK_SECRET);
  const jwtIssuer = parseOptionalString(env.JWT_ISSUER);
  const jwtAudience = parseOptionalString(env.JWT_AUDIENCE);
  const corsAllowedOrigins = parseStringList(env.CORS_ALLOWED_ORIGINS);
  
  let horizonUrls: string[] | undefined;
  if (env.HORIZON_URLS) {
    horizonUrls = parseUrlList(env.HORIZON_URLS, "HORIZON_URLS", issues);
  } else if (env.HORIZON_URL) {
    const singleUrl = parseOptionalUrl(env.HORIZON_URL, "HORIZON_URL", issues);
    if (singleUrl) {
      horizonUrls = [singleUrl];
    }
  }

  const networkPassphrase = parseOptionalString(env.STELLAR_NETWORK_PASSPHRASE);
  const escrowContractHash = parseOptionalString(env.ESCROW_CONTRACT_HASH);
  const appUrl = parseOptionalString(env.APP_URL);

  const internalOverrideSecret = parseOptionalString(env.INTERNAL_OVERRIDE_SECRET);
  const internalOverrideSecretPrev = parseOptionalString(env.INTERNAL_OVERRIDE_SECRET_PREV);
  const internalBypassToleranceMs = parsePositiveInteger(
    env.INTERNAL_BYPASS_TOLERANCE_MS,
    "INTERNAL_BYPASS_TOLERANCE_MS",
    30_000,
    issues,
  );

  const mfaIssuer = parseOptionalString(env.MFA_ISSUER);
  const mfaFreshnessMs = parsePositiveInteger(
    env.MFA_FRESHNESS_MS,
    "MFA_FRESHNESS_MS",
    15 * 60 * 1000,
    issues,
  );
  const mfaWindowPeriods = parsePositiveInteger(
    env.MFA_WINDOW_PERIODS,
    "MFA_WINDOW_PERIODS",
    1,
    issues,
  );
  const mfaChallengeTtlSec = parsePositiveInteger(
    env.MFA_CHALLENGE_TTL_SEC,
    "MFA_CHALLENGE_TTL_SEC",
    300,
    issues,
  );
  const mfaRequiredForRefunds = parseBoolean(
    env.MFA_REQUIRED_FOR_REFUNDS,
    "MFA_REQUIRED_FOR_REFUNDS",
    nodeEnv === "production",
    issues,
  );

  const metricsAuthToken = parseOptionalString(env.METRICS_AUTH_TOKEN);
  const metricsPublic = parseBoolean(env.METRICS_PUBLIC, "METRICS_PUBLIC", false, issues);
  if (nodeEnv === "production" && metricsAuthToken === undefined && !metricsPublic) {
    issues.push(
      "METRICS_AUTH_TOKEN must be set in production. Set METRICS_PUBLIC=true to explicitly allow an unauthenticated /metrics endpoint.",
    );
  }

  const residencyTrustRegionHeaders = parseBoolean(
    env.RESIDENCY_TRUST_REGION_HEADERS,
    "RESIDENCY_TRUST_REGION_HEADERS",
    false,
    issues,
  );
  const residencyEdgeSecret = parseOptionalString(env.RESIDENCY_EDGE_SECRET);

  const idempotencyProcessingLockTtlSeconds = parseOptionalPositiveInteger(
    env.IDEMPOTENCY_PROCESSING_LOCK_TTL_SECONDS,
    "IDEMPOTENCY_PROCESSING_LOCK_TTL_SECONDS",
    issues,
  );

  const idempotencyRedisEncryption = parseIdempotencyRedisEncryption(env, issues);

  const treasuryAccounts = parseStringList(env.TREASURY_ACCOUNTS);
  const treasuryFloors = parseTreasuryFloorsJson(env.TREASURY_FLOORS_JSON, issues);
  const treasuryPollIntervalMs = parsePositiveInteger(
    env.TREASURY_POLL_INTERVAL_MS,
    "TREASURY_POLL_INTERVAL_MS",
    30_000,
    issues,
  );
  const treasuryMaxStalenessMs = parsePositiveInteger(
    env.TREASURY_MAX_STALENESS_MS,
    "TREASURY_MAX_STALENESS_MS",
    120_000,
    issues,
  );

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    nodeEnv,
    port,
    redisUrl,
    rateLimitWindowMs,
    rateLimitMax,
    quotaFailMode,
    trustProxy,
    enableTestRoutes,
    timeoutMs,
    webhookSecret,
    jwtIssuer,
    jwtAudience,
    corsAllowedOrigins,
    horizonUrls,
    networkPassphrase,
    escrowContractHash,
    appUrl,
    internalOverrideSecret,
    internalOverrideSecretPrev,
    internalBypassToleranceMs,
    mfaIssuer,
    mfaFreshnessMs,
    mfaWindowPeriods,
    mfaChallengeTtlSec,
    mfaRequiredForRefunds,
    metricsAuthToken,
    metricsPublic,
    idempotencyRedisEncryption,
    residencyTrustRegionHeaders,
    residencyEdgeSecret,
    treasuryAccounts,
    treasuryFloors,
    treasuryPollIntervalMs,
    treasuryMaxStalenessMs,
  };
}

function parseQuotaFailMode(rawValue: string | undefined, issues: string[]): QuotaFailMode {
  if (rawValue === undefined) return "open";

  const value = rawValue.trim();
  if (value === "open" || value === "closed") return value;

  issues.push("QUOTA_FAIL_MODE must be one of: open, closed.");
  return "open";
}

function parseNodeEnv(rawValue: string | undefined, issues: string[]): NodeEnv {
  if (rawValue === undefined) return "development";

  const value = rawValue.trim();
  const allowedValues: NodeEnv[] = ["development", "test", "production"];

  if (value.length === 0) {
    issues.push("NODE_ENV must be a non-empty value when provided.");
    return "development";
  }

  if (!allowedValues.includes(value as NodeEnv)) {
    issues.push("NODE_ENV must be one of: development, test, production.");
    return "development";
  }

  return value as NodeEnv;
}

function parsePort(rawValue: string | undefined, issues: string[]): number {
  return parseIntegerInRange(rawValue, "PORT", 3001, 1, 65535, issues);
}

function parsePositiveInteger(
  rawValue: string | undefined,
  key: string,
  defaultValue: number,
  issues: string[],
): number {
  return parseIntegerInRange(rawValue, key, defaultValue, 1, Number.MAX_SAFE_INTEGER, issues);
}

function parseOptionalPositiveInteger(
  rawValue: string | undefined,
  key: string,
  issues: string[],
): number | undefined {
  if (rawValue === undefined) return undefined;

  const value = rawValue.trim();
  if (value.length === 0) {
    issues.push(`${key} must be a non-empty integer when provided.`);
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be a whole number between 1 and ${Number.MAX_SAFE_INTEGER}.`);
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > Number.MAX_SAFE_INTEGER) {
    issues.push(`${key} must be a whole number between 1 and ${Number.MAX_SAFE_INTEGER}.`);
    return undefined;
  }

  return parsed;
}

function parseIntegerInRange(
  rawValue: string | undefined,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
  issues: string[],
): number {
  if (rawValue === undefined) return defaultValue;

  const value = rawValue.trim();
  if (value.length === 0) {
    issues.push(`${key} must be a non-empty integer when provided.`);
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    issues.push(`${key} must be a whole number between ${min} and ${max}.`);
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    issues.push(`${key} must be a whole number between ${min} and ${max}.`);
    return defaultValue;
  }

  return parsed;
}

function parseRedisUrl(rawValue: string | undefined, issues: string[]): string {
  if (rawValue === undefined) {
    issues.push("REDIS_URL is required.");
    return "redis://localhost:6379";
  }

  const value = rawValue.trim();

  if (value.length === 0) {
    issues.push("REDIS_ULL must be a non-empty value.");
    return "redis://localhost:6379";
  }

  try {
    const url = new URL(value);
    const allowedSchemes = ["redis:", "rediss:"];

    if (!allowedSchemes.includes(url.protocol)) {
      issues.push("REDIS_URL must use one of the supported schemes: redis, rediss.");
      return "redis://localhost:6379";
    }

    if (!url.hostname) {
      issues.push("REDIS_ULL must include a host.");
      return "redis://localhost:6379";
    }

    if (url.username || url.password) {
      issues.push("REDIS_URL must not contain embedded credentials.");
      return "redis://localhost:6379";
    }

    if (/\s/.test(value)) {
      issues.push("REDIS_URL must not contain whitespace.");
      return "redis://localhost:6379";
    }

    return value;
  } catch {
    issues.push("REDIS_URL must be a valid URL.");
    return "redis://localhost:6379";
  }
}

function parseBoolean(rawValue: string | undefined, key: string, defaultValue: boolean, issues: string[]): boolean {
  if (rawValue === undefined) return defaultValue;
  const val = rawValue.trim().toLowerCase();
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  issues.push(`${key} must be one of: true, false, 1, 0.`);
  return defaultValue;
}

function parseOptionalString(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  const val = rawValue.trim();
  if (val === "") return undefined;
  return val;
}

const IDEMPOTENCY_ENCRYPTION_KEY_BYTES = 32;

/**
 * Decode a base64 encryption key and require it to be exactly 32 bytes.
 *
 * Only canonical (padded) base64 is accepted, because Buffer.from(..., "base64")
 * silently skips invalid characters. The key material is never included in the
 * reported issue, only its name and decoded length.
 */
function parseEncryptionKeyBytes(rawValue: string, label: string, issues: string[]): Buffer | undefined {
  const decoded = Buffer.from(rawValue, "base64");

  if (rawValue === "" || decoded.toString("base64") !== rawValue) {
    issues.push(`${label} must be valid base64.`);
    return undefined;
  }

  if (decoded.length !== IDEMPOTENCY_ENCRYPTION_KEY_BYTES) {
    issues.push(
      `${label} must decode to exactly ${IDEMPOTENCY_ENCRYPTION_KEY_BYTES} bytes (got ${decoded.length}).`,
    );
    return undefined;
  }

  return decoded;
}

function parseIdempotencyRedisEncryption(
  env: NodeJS.ProcessEnv,
  issues: string[],
): IdempotencyRedisEncryptionConfig {
  const enabledKey = "IDEMPOTENCY_REDIS_ENCRYPTION_ENABLED";
  const activeKeyIdName = "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY_ID";
  const activeKeyName = "IDEMPOTENCY_REDIS_ENCRYPTION_ACTIVE_KEY";
  const previousKeysName = "IDEMPOTENCY_REDIS_ENCRYPTION_PREVIOUS_KEYS";

  const enabled = parseBoolean(env[enabledKey], enabledKey, false, issues);
  const activeKeyId = parseOptionalString(env[activeKeyIdName]);
  const activeKeyRaw = parseOptionalString(env[activeKeyName]);
  const previousKeysRaw = parseOptionalString(env[previousKeysName]);

  if (enabled) {
    if (activeKeyId === undefined) {
      issues.push(`${activeKeyIdName} is required when ${enabledKey} is true.`);
    }
    if (activeKeyRaw === undefined) {
      issues.push(`${activeKeyName} is required when ${enabledKey} is true.`);
    }
  }

  // Validate whatever was provided, even while disabled, so a malformed key is
  // caught at startup rather than the day encryption is switched on.
  let activeKey: EncryptionKey | null = null;
  if (activeKeyRaw !== undefined) {
    const value = parseEncryptionKeyBytes(activeKeyRaw, activeKeyName, issues);
    if (value && activeKeyId !== undefined) {
      activeKey = { id: activeKeyId, value };
    }
  }

  const seenIds = new Set<string>();
  if (activeKeyId !== undefined) {
    seenIds.add(activeKeyId);
  }

  const previousKeys: EncryptionKey[] = [];
  for (const entry of parseStringList(previousKeysRaw)) {
    const separator = entry.indexOf(":");
    const id = separator === -1 ? "" : entry.slice(0, separator).trim();
    const rawKey = separator === -1 ? "" : entry.slice(separator + 1).trim();

    if (id === "" || rawKey === "") {
      issues.push(`${previousKeysName} entries must use the format key-id:base64-key.`);
      continue;
    }

    if (seenIds.has(id)) {
      issues.push(`${previousKeysName} contains duplicate key id '${id}'.`);
      continue;
    }
    seenIds.add(id);

    const value = parseEncryptionKeyBytes(rawKey, `${previousKeysName} key '${id}'`, issues);
    if (value) {
      previousKeys.push({ id, value });
    }
  }

  // The active key must stay decryptable, and previous keys cover the rotation window.
  const decryptionKeys: EncryptionKey[] = activeKey ? [activeKey, ...previousKeys] : previousKeys;

  if (enabled && activeKey) {
    return { enabled: true, algorithm: "aes-256-gcm", activeKey, decryptionKeys };
  }

  // Disabled, or enabled with invalid input (already recorded in `issues`, which
  // makes loadEnvConfig throw before this value is used).
  return { enabled: false, algorithm: "aes-256-gcm", activeKey: null, decryptionKeys };
}

function parseStringList(rawValue: string | undefined): string[] {
  if (rawValue === undefined) return [];
  return rawValue.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseUrlList(rawValue: string, key: string, issues: string[]): string[] {
  const urls: string[] = [];
  for (const entry of parseStringList(rawValue)) {
    const url = parseOptionalUrl(entry, key, issues);
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}

function parseOptionalUrl(rawValue: string | undefined, key: string, issues: string[]): string | undefined {
  if (rawValue === undefined) return undefined;
  const value = rawValue.trim();
  if (value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https::"].includes(url.protocol)) {
      issues.push(`${key} must use http or https scheme.`);
      return undefined;
    }
    return value;
  } catch {
    issues.push(`${key} must be a valid URL.`);
    return undefined;
  }
}

function _parseReplicaId(rawValue: string | undefined): string {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    // Fall back to the OS hostname so each pod/container gets a distinct ID
    // without requiring explicit config.
    try {
      return os.hostname();
    } catch {
      return "unknown-replica";
    }
  }
  return rawValue.trim();
}

function _parseFloat01(rawValue: string | undefined, key: string, defaultValue: number, issues: string[]): number {
  if (rawValue === undefined) return defaultValue;
  const value = rawValue.trim();
  if (value.length === 0) {
    issues.push(`${key} must be a number between 0 and 1.`);
    return defaultValue;
  }
  const parsed = Number(value);
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    issues.push(`${key} must be a number between 0.0 and 1.0.`);
    return defaultValue;
  }
  return parsed;
}

function parseTreasuryFloorsJson(
  rawValue: string | undefined,
  issues: string[],
): TreasuryFloorConfig[] {
  if (rawValue === undefined) return [];
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid JSON";
    issues.push(`TREASURY_FLOORS_JSON must be valid JSON (${detail}).`);
    return [];
  }

  const results: TreasuryFloorConfig[] = [];

  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        issues.push(`TREASURY_FLOORS_JSON[${i}] must be an object with 'asset' and 'floor'.`);
        continue;
      }
      const record = item as Record<string, unknown>;
      const asset = typeof record.asset === "string" ? record.asset.trim() : "";
      if (asset.length === 0) {
        issues.push(`TREASURY_FLOORS_JSON[${i}].asset must be a non-empty string.`);
        continue;
      }
      const floor = record.floor;
      if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
        issues.push(`TREASURY_FLOORS_JSON[${i}].floor must be a non-negative finite number.`);
        continue;
      }
      const hysteresis = record.hysteresis;
      if (hysteresis !== undefined) {
        if (typeof hysteresis !== "number" || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 1) {
          issues.push(`TREASURY_FLOORS_JSON[${i}].hysteresis must be a number between 0 and 1.`);
          continue;
        }
      }
      results.push(hysteresis !== undefined ? { asset, floor, hysteresis } : { asset, floor });
    }
    return results;
  }

  if (typeof parsed === "object" && parsed !== null) {
    for (const [rawAsset, value] of Object.entries(parsed as Record<string, unknown>)) {
      const asset = rawAsset.trim();
      if (asset.length === 0) {
        issues.push("TREASURY_FLOORS_JSON contains an empty asset key.");
        continue;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
          issues.push(`TREASURY_FLOORS_JSON.${asset} must be a non-negative finite number.`);
          continue;
        }
        results.push({ asset, floor: value });
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const floor = record.floor;
        if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
          issues.push(`TREASURY_FLOORS_JSON.${asset}.floor must be a non-negative finite number.`);
          continue;
        }
        const hysteresis = record.hysteresis;
        if (hysteresis !== undefined) {
          if (typeof hysteresis !== "number" || !Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 1) {
            issues.push(`TREASURY_FLOORS_JSON.${asset}.hysteresis must be a number between 0 and 1.`);
            continue;
          }
        }
        results.push(hysteresis !== undefined ? { asset, floor, hysteresis } : { asset, floor });
      } else {
        issues.push(
          `TREASURY_FLOORS_JSON.${asset} must be a non-negative number or an object with 'floor'.`,
        );
      }
    }
    return results;
  }

  issues.push(
    "TREASURY_FLOORS_JSON must be a JSON array of { asset, floor, hysteresis? } or an object mapping asset to floor.",
  );
  return [];
}

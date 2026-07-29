/**
 * Typed Configuration and Secret Rotation Service
 */

import process from "node:process";
import { loadEnvConfig, type EnvConfig } from "./env.js";
import {
  createSecretsProviderFromEnv,
  type SecretsProvider,
} from "../services/secrets/index.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[ConfigService] ${message}`);
    this.name = "ConfigError";
  }
}

export interface SecretVersions {
  primary: string;
  previous?: string;
}

export class ConfigService {
  private static instance: ConfigService;
  private readonly secrets = new Map<string, SecretVersions>();
  private envConfig: EnvConfig;
  private secretsProvider: SecretsProvider;

  private constructor() {
    this.envConfig = loadEnvConfig(process.env);
    this.secretsProvider = createSecretsProviderFromEnv({
      defaultTtlSeconds: Number(process.env.SECRET_CACHE_TTL_SECONDS ?? 300),
    });

    // initial load
    void this.loadSecretsFromProvider();

    // listen for rotation events
    this.secretsProvider.on("rotate", (_key?: string) => {
      // when rotation occurs, refresh the in-memory secrets
      try {
        void this.loadSecretsFromProvider();
      } catch (err) {
        // swallow - keep existing secrets if refresh fails

        console.error("Failed to refresh secrets on rotation:", err);
      }
    });
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  public get nodeEnv() {
    return this.envConfig.nodeEnv;
  }

  public get port() {
    return this.envConfig.port;
  }

  public get timeoutMs() {
    return this.envConfig.timeoutMs;
  }

  public get rateLimitWindowMs() {
    return this.envConfig.rateLimitWindowMs;
  }

  public get rateLimitMax() {
    return this.envConfig.rateLimitMax;
  }

  public get trustProxy() {
    return this.envConfig.trustProxy;
  }

  public get webhookSecret() {
    return this.envConfig.webhookSecret;
  }

  public get internalOverrideSecret() {
    return this.envConfig.internalOverrideSecret;
  }

  public get internalOverrideSecretPrev() {
    return this.envConfig.internalOverrideSecretPrev;
  }

  public get internalBypassToleranceMs() {
    return this.envConfig.internalBypassToleranceMs;
  }

  public get jwtIssuer() {
    return this.envConfig.jwtIssuer;
  }

  public get jwtAudience() {
    return this.envConfig.jwtAudience;
  }

  public get corsAllowedOrigins() {
    // @ts-expect-error - Auto-fixed by script
    return [...this.envConfig.corsAllowedOrigins];
  }

  private async loadSecretsFromProvider(): Promise<void> {
    this.secrets.clear();

    const relevantKeys = [
      "JWT_SECRET",
      "API_KEY",
      "STELLAR_SECRET_KEY",
      "WEBHOOK_SECRET",
    ];

    for (const key of relevantKeys) {
      try {
        const versions = await this.secretsProvider.getAllVersions(key);
        if (versions.length === 0) continue;
        this.secrets.set(key, {
          primary: versions[0],
          previous: versions[1] || undefined,
        });
      } catch (_err) {
        // ignore missing keys from provider
      }
    }
  }

  public getSecret(key: string): string {
    const versions = this.secrets.get(key);
    if (!versions) {
      throw new ConfigError(`Secret not found: ${key}`);
    }
    return versions.primary;
  }

  public getAllSecretVersions(key: string): string[] {
    const versions = this.secrets.get(key);
    if (!versions) return [];

    const result = [versions.primary];
    if (versions.previous) result.push(versions.previous);

    return result;
  }

  public refresh(): void {
    this.envConfig = loadEnvConfig(process.env);
    void this.loadSecretsFromProvider();
  }

  public validateConfig(key: string): boolean {
    const versions = this.secrets.get(key);
    return !!versions && versions.primary.length > 0;
  }
}

export const configService = ConfigService.getInstance();
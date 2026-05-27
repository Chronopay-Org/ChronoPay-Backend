/**
 * Typed Configuration and Secret Rotation Service
 */

import process from "node:process";
import { loadEnvConfig, type EnvConfig } from "./env.js";

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

  private constructor() {
    this.envConfig = loadEnvConfig(process.env);
    this.loadSecretsFromEnv();
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

  public get jwtIssuer() {
    return this.envConfig.jwtIssuer;
  }

  public get jwtAudience() {
    return this.envConfig.jwtAudience;
  }

  public get corsAllowedOrigins() {
    return [...this.envConfig.corsAllowedOrigins];
  }

  private loadSecretsFromEnv(): void {
    this.secrets.clear();

    const relevantKeys = [
      "JWT_SECRET",
      "API_KEY",
      "STELLAR_SECRET_KEY",
      "WEBHOOK_SECRET",
    ];

    for (const key of relevantKeys) {
      const primary = process.env[key]?.trim();
      const previous = process.env[`${key}_PREV`]?.trim();

      if (primary) {
        this.secrets.set(key, {
          primary,
          previous: previous || undefined,
        });
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
    this.loadSecretsFromEnv();
  }

  public validateConfig(key: string): boolean {
    const versions = this.secrets.get(key);
    return !!versions && versions.primary.length > 0;
  }
}

export const configService = ConfigService.getInstance();
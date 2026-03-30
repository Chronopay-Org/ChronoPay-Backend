/**
 * Secret Management and Rotation Service
 * 
 * This service provides a centralized way to manage and rotate application secrets.
 * It supports multi-versioning for graceful secret rotation, allowing the application
 * to transition between secrets without downtime.
 */

import process from "node:process";

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

  private constructor() {
    this.loadFromEnv();
  }

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * Loads secrets from environment variables.
   * Looks for KEY and KEY_PREV patterns.
   */
  private loadFromEnv(): void {
    const relevantKeys = [
      "JWT_SECRET",
      "API_KEY",
      "STELLAR_SECRET_KEY",
      // Add more secret keys as needed
    ];

    for (const key of relevantKeys) {
      const primary = process.env[key];
      const previous = process.env[`${key}_PREV`];

      if (primary) {
        this.secrets.set(key, { primary, previous });
      }
    }
  }

  /**
   * Retrieves the primary version of a secret.
   * Use this for new operations (e.g., signing a new token).
   * @throws ConfigError if the secret is not found.
   */
  public getSecret(key: string): string {
    const versions = this.secrets.get(key);
    if (!versions) {
      throw new ConfigError(`Secret not found: ${key}`);
    }
    return versions.primary;
  }

  /**
   * Retrieves all active versions of a secret.
   * Use this for validation operations (e.g., verifying an existing token).
   */
  public getAllSecretVersions(key: string): string[] {
    const versions = this.secrets.get(key);
    if (!versions) {
      return [];
    }
    const result = [versions.primary];
    if (versions.previous) {
      result.push(versions.previous);
    }
    return result;
  }

  /**
   * Manual refresh of secrets from environment.
   * Useful in scenarios where environment variables might be updated dynamically.
   */
  public refresh(): void {
    this.loadFromEnv();
  }

  /**
   * Validates if a secret is configured correctly.
   */
  public validateConfig(key: string): boolean {
    const versions = this.secrets.get(key);
    return !!versions && versions.primary.length > 0;
  }
}

export const configService = ConfigService.getInstance();

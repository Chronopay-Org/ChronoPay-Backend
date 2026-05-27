import { configService } from "./config.service.js";

export type JwtSecretVersion = {
  version: string;
  secret: string;
  active: boolean;
};

export interface JwtConfig {
  issuer?: string;
  audience?: string;
}

export function getJwtConfig(): JwtConfig {
  return {
    issuer: configService.jwtIssuer,
    audience: configService.jwtAudience,
  };
}

export function getAllSecretVersions(key: string): JwtSecretVersion[] {
  return configService.getAllSecretVersions(key).map((secret, index) => ({
    version: index === 0 ? "primary" : `previous-${index}`,
    secret,
    active: true,
  }));
}

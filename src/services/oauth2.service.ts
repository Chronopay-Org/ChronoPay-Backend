import crypto from "node:crypto";
import { configService } from "../config/config.service.js";

/**
 * OAuth2 provider configuration
 */
export interface OAuth2ProviderConfig {
  name: "google" | "github";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  scopes: string[];
}

/**
 * OAuth2 token response
 */
export interface OAuth2TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
}

/**
 * OAuth2 user info
 */
export interface OAuth2UserInfo {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  provider: "google" | "github";
}

/**
 * PKCE challenge pair
 */
export interface PKCEChallenge {
  codeChallenge: string;
  codeVerifier: string;
  method: "S256";
}

export class OAuth2Error extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "OAuth2Error";
  }
}

export class OAuth2Service {
  private static instance: OAuth2Service;
  private providers = new Map<string, OAuth2ProviderConfig>();

  private constructor() {
    this.initializeProviders();
  }

  public static getInstance(): OAuth2Service {
    if (!OAuth2Service.instance) {
      OAuth2Service.instance = new OAuth2Service();
    }
    return OAuth2Service.instance;
  }

  /**
   * Initialize OAuth2 providers with env vars
   */
  private initializeProviders(): void {
    // Google OAuth2 config
    const googleClientId = process.env.OAUTH_GOOGLE_CLIENT_ID?.trim();
    const googleClientSecret = process.env.OAUTH_GOOGLE_CLIENT_SECRET?.trim();
    const googleRedirectUri = process.env.OAUTH_GOOGLE_REDIRECT_URI?.trim();

    if (googleClientId && googleClientSecret && googleRedirectUri) {
      this.providers.set("google", {
        name: "google",
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: googleRedirectUri,
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        scopes: ["openid", "profile", "email"],
      });
    }

    // GitHub OAuth2 config
    const githubClientId = process.env.OAUTH_GITHUB_CLIENT_ID?.trim();
    const githubClientSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET?.trim();
    const githubRedirectUri = process.env.OAUTH_GITHUB_REDIRECT_URI?.trim();

    if (githubClientId && githubClientSecret && githubRedirectUri) {
      this.providers.set("github", {
        name: "github",
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        redirectUri: githubRedirectUri,
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        userInfoEndpoint: "https://api.github.com/user",
        scopes: ["user:email"],
      });
    }
  }

  /**
   * Get provider configuration by name
   */
  public getProvider(provider: string): OAuth2ProviderConfig {
    const config = this.providers.get(provider);
    if (!config) {
      throw new OAuth2Error("invalid_provider", `Provider '${provider}' is not configured`, 400);
    }
    return config;
  }

  /**
   * Get list of enabled providers
   */
  public getEnabledProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Generate PKCE challenge pair
   */
  public generatePKCEChallenge(): PKCEChallenge {
    // Generate a random code verifier (between 43-128 characters)
    const codeVerifier = crypto.randomBytes(32).toString("base64url");

    // Create S256 challenge (SHA256 hash of verifier)
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    return {
      codeChallenge,
      codeVerifier,
      method: "S256",
    };
  }

  /**
   * Generate a random state string
   */
  public generateState(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Build authorization URL for the provider
   */
  public buildAuthorizationUrl(
    provider: string,
    codeChallenge: string,
    state: string,
    nonce?: string,
  ): string {
    const config = this.getProvider(provider);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(" "),
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    if (nonce) {
      params.append("nonce", nonce);
    }

    return `${config.authorizationEndpoint}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   */
  public async exchangeCodeForToken(
    provider: string,
    code: string,
    codeVerifier: string,
  ): Promise<OAuth2TokenResponse> {
    const config = this.getProvider(provider);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: codeVerifier,
    });

    const response = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new OAuth2Error(
        "token_exchange_failed",
        `Failed to exchange code for token: ${error}`,
        response.status,
      );
    }

    const data = (await response.json()) as OAuth2TokenResponse;
    return data;
  }

  /**
   * Fetch user info from provider using access token
   */
  public async fetchUserInfo(provider: string, accessToken: string): Promise<OAuth2UserInfo> {
    const config = this.getProvider(provider);

    const response = await fetch(config.userInfoEndpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new OAuth2Error(
        "user_info_fetch_failed",
        `Failed to fetch user info from ${provider}`,
        response.status,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return this.parseUserInfo(provider, data);
  }

  /**
   * Parse provider-specific user info into standard format
   */
  private parseUserInfo(provider: string, data: Record<string, unknown>): OAuth2UserInfo {
    if (provider === "google") {
      return {
        id: String(data.sub || data.id || ""),
        email: String(data.email || ""),
        name: data.name ? String(data.name) : undefined,
        picture: data.picture ? String(data.picture) : undefined,
        provider: "google",
      };
    }

    if (provider === "github") {
      return {
        id: String(data.id || ""),
        email: String(data.email || ""),
        name: data.name ? String(data.name) : undefined,
        picture: data.avatar_url ? String(data.avatar_url) : undefined,
        provider: "github",
      };
    }

    throw new OAuth2Error("invalid_provider", `Provider '${provider}' is not supported`, 400);
  }

  /**
   * Verify nonce matches (for ID token validation)
   */
  public verifyNonce(storedNonce: string, tokenNonce: string | undefined): boolean {
    if (!tokenNonce) {
      return false;
    }
    return storedNonce === tokenNonce;
  }
}

export const oauth2Service = OAuth2Service.getInstance();

import EventEmitter from "events";

export type SecretVersions = {
  primary: string;
  previous?: string;
};

export interface SecretsProvider extends EventEmitter {
  getSecret(key: string): Promise<string>;
  getAllVersions(key: string): Promise<string[]>;
  refresh?(): Promise<void> | void;
}

export type SecretsProviderOptions = {
  // default TTL in seconds
  defaultTtlSeconds?: number;
  // per-key TTLs (key name -> seconds)
  ttlSecondsByKey?: Record<string, number>;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class EnvSecretsProvider extends EventEmitter implements SecretsProvider {
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private opts: Required<SecretsProviderOptions>;

  constructor(opts?: SecretsProviderOptions) {
    super();
    this.opts = {
      defaultTtlSeconds: opts?.defaultTtlSeconds ?? 300,
      ttlSecondsByKey: opts?.ttlSecondsByKey ?? {},
    };
  }

  private ttlForKey(key: string): number {
    return this.opts.ttlSecondsByKey[key] ?? this.opts.defaultTtlSeconds;
  }

  public async getSecret(key: string): Promise<string> {
    const cached = this.cache.get(key);
    const now = nowSeconds();
    if (cached && cached.expiresAt > now) return cached.value;

    const primary = process.env[key];
    if (!primary || primary.trim().length === 0) {
      throw new Error(`Secret not found in env: ${key}`);
    }

    const value = primary.trim();
    const ttl = this.ttlForKey(key);
    this.cache.set(key, { value, expiresAt: now + ttl });
    return value;
  }

  public async getAllVersions(key: string): Promise<string[]> {
    const primary = process.env[key]?.trim();
    const previous = process.env[`${key}_PREV`]?.trim();
    if (!primary) return [];
    const out = [primary];
    if (previous) out.push(previous);
    return out;
  }

  public async refresh(): Promise<void> {
    this.cache.clear();
    // emit rotate for all keys that look like secrets in env
    // Consumers can decide how to filter keys.
    this.emit("rotate", undefined);
  }
}

export function createSecretsProviderFromEnv(opts?: SecretsProviderOptions): SecretsProvider {
  return new EnvSecretsProvider(opts);
}

export default SecretsProvider;

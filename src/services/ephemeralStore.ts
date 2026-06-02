export interface EphemeralStore<T> {
  set(key: string, value: T, ttlSeconds: number): Promise<void>;
  get(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
}

interface InMemoryEntry<T> {
  value: T;
  timeout: NodeJS.Timeout;
}

export class InMemoryEphemeralStore<T> implements EphemeralStore<T> {
  private readonly store = new Map<string, InMemoryEntry<T>>();

  public async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.delete(key);

    const timeout = setTimeout(() => {
      this.store.delete(key);
    }, ttlSeconds * 1000);

    this.store.set(key, { value, timeout });
  }

  public async get(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    return entry?.value;
  }

  public async delete(key: string): Promise<void> {
    const entry = this.store.get(key);
    if (entry) {
      clearTimeout(entry.timeout);
      this.store.delete(key);
    }
  }
}

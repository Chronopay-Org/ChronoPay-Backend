/** Minimal ioredis stub for test environments where ioredis is not installed. */
export class Redis {
  get(_key: string): Promise<string | null> { return Promise.resolve(null); }
  set(_key: string, _value: string, _exMode: string, _ttl: number): Promise<string> { return Promise.resolve("OK"); }
  del(_key: string): Promise<number> { return Promise.resolve(0); }
  quit(): Promise<string> { return Promise.resolve("OK"); }
  on(_event: string, _handler: unknown): this { return this; }
}

export default Redis;

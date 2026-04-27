/** Minimal pg stub for test environments where pg is not installed. */

export class Pool {
  constructor(_opts?: unknown) {}
  connect(): Promise<PoolClient> { return Promise.resolve(new PoolClient()); }
  end(): Promise<void> { return Promise.resolve(); }
  on(_event: string, _handler: unknown): this { return this; }
  query(_text: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

export class PoolClient {
  query(_text: string, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  release(): void {}
}

export type QueryResult = { rows: unknown[]; rowCount: number };

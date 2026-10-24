import { EventEmitter } from "node:events";

// Minimal type stubs so imports of QueryResult, PoolClient, etc. resolve
// when the real `pg` module is replaced by this mock in Jest.
export interface QueryResult<R = any> {
  rows: R[];
  rowCount: number | null;
  command: string;
  oid: number;
  fields: any[];
}

export interface PoolClient {
  query: (text: string, values?: any[]) => Promise<QueryResult>;
  release: (err?: Error) => void;
}

export class Pool extends EventEmitter {
  constructor() {
    super();
  }
  async connect() {
    return {
      query: async () => ({ rows: [] }),
      release: () => {},
    };
  }
  async query() {
    return { rows: [] };
  }
  async end() {}
}

export class Client {
  constructor() {}
  async connect() {}
  async query() { return { rows: [] }; }
  async end() {}
}

export default { Pool, Client };

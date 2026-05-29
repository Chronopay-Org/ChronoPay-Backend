/**
 * Mock for pg library
 * Used in tests to avoid PostgreSQL dependency
 */

export class Pool {
  constructor() {}
  async connect() {
    return {
      query: async () => ({ rows: [] }),
      release: () => {},
    };
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

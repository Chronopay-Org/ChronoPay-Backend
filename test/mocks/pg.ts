import { EventEmitter } from "node:events";

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

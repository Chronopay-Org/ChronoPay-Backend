// src/services/quarantineStore.ts
import { v4 as uuidv4 } from "uuid";

/** Simple in‑memory store for quarantine intents. */
export class QuarantineStore {
  private readonly store = new Map<string, any>();

  /** Add a new quarantine entry and return its id. */
  add(data: any): string {
    const id = uuidv4();
    this.store.set(id, data);
    return id;
  }

  /** Retrieve an entry by id. */
  get(id: string): any | undefined {
    return this.store.get(id);
  }

  /** Delete an entry. */
  delete(id: string): void {
    this.store.delete(id);
  }
}

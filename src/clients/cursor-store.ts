/**
 * Durable store for SSE stream cursor bookmarks.
 *
 * A cursor (also known as a "paging token" in Stellar Horizon) marks the last
 * successfully-acknowledged event in a streaming response.  Persisting the
 * cursor allows a reconnecting client to resume from where it left off —
 * avoiding both duplicate delivery and data loss.
 *
 * Implementations may back this with Redis, a database, or (for testing /
 * development) plain in-process memory.
 */
export interface CursorStore {
  /**
   * Retrieve the last acknowledged cursor for a named stream.
   *
   * @param streamKey  Logical name of the stream (e.g. "payments:GACCOUNT…").
   * @returns          The cursor string, or `undefined` if none has been saved.
   */
  get(streamKey: string): Promise<string | undefined>;

  /**
   * Persist the latest acknowledged cursor for a named stream.
   *
   * @param streamKey  Logical name of the stream.
   * @param cursor     Opaque cursor / paging-token returned by Horizon.
   */
  set(streamKey: string, cursor: string): Promise<void>;

  /**
   * Remove the stored cursor for a named stream (e.g. on intentional reset).
   *
   * @param streamKey  Logical name of the stream.
   */
  delete(streamKey: string): Promise<void>;
}

/**
 * Volatile, in-process implementation of {@link CursorStore}.
 *
 * Suitable for:
 *   - Unit and integration tests (fast, zero-dependency)
 *   - Single-instance development servers where persistence on restart is not
 *     required
 *
 * NOT suitable for:
 *   - Production multi-instance deployments (state is not shared across
 *     processes; cursors are lost on restart)
 */
export class InMemoryCursorStore implements CursorStore {
  private readonly store = new Map<string, string>();

  async get(streamKey: string): Promise<string | undefined> {
    return this.store.get(streamKey);
  }

  async set(streamKey: string, cursor: string): Promise<void> {
    this.store.set(streamKey, cursor);
  }

  async delete(streamKey: string): Promise<void> {
    this.store.delete(streamKey);
  }

  /**
   * Returns the number of cursors currently held in the store.
   * Useful for test assertions.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Clears all cursors.  Useful for test teardown.
   */
  clear(): void {
    this.store.clear();
  }
}

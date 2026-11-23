import { InMemoryCursorStore } from '../cursor-store.js';

describe('InMemoryCursorStore', () => {
  it('returns undefined for unknown streams and isolates stream keys', async () => {
    const store = new InMemoryCursorStore();

    expect(await store.get('missing')).toBeUndefined();
    await store.set('payments:account-a', 'cursor-1');

    expect(await store.get('payments:account-a')).toBe('cursor-1');
    expect(await store.get('payments:account-b')).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('persists the latest cursor and supports an idempotent delete', async () => {
    const store = new InMemoryCursorStore();

    await store.set('payments:account-a', 'cursor-1');
    await store.set('payments:account-a', 'cursor-2');
    expect(await store.get('payments:account-a')).toBe('cursor-2');

    await store.delete('payments:account-a');
    await store.delete('payments:account-a');
    expect(await store.get('payments:account-a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('clears all cursors without sharing state between instances', async () => {
    const store = new InMemoryCursorStore();
    const other = new InMemoryCursorStore();
    await store.set('a', '1');
    await store.set('b', '2');
    await other.set('a', 'other');

    store.clear();

    expect(store.size).toBe(0);
    expect(await store.get('a')).toBeUndefined();
    expect(await other.get('a')).toBe('other');
  });
});

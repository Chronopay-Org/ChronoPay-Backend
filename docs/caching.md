# Caching Strategy

## Overview

ChronoPay-Backend uses Redis for caching frequently accessed data to improve performance and reduce database load. This document describes the cache key schema, invalidation strategy, and security considerations.

## Cache Key Schema

### Slots Resource

The slots resource uses a paginated cache strategy to efficiently serve large datasets.

#### Current Keys

| Key Pattern | Description | Data Format | TTL |
|-------------|-------------|-------------|-----|
| `slots:all` | Legacy single-key cache (deprecated) | JSON array of slots | 60s |
| `slots:page:<num>` | Paginated slot lists (e.g., `slots:page:1`, `slots:page:2`) | JSON object with pagination metadata | 60s |

#### Paginated Cache Structure

```typescript
interface PaginatedSlotsResult {
  slots: Slot[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
```

#### Key Generation

Cache keys are generated using the following pattern:

```typescript
SLOT_CACHE_KEYS.page(pageNum) // Returns "slots:page:{pageNum}"
```

Example:
- Page 1: `slots:page:1`
- Page 2: `slots:page:2`
- Page 3: `slots:page:3`

## Cache Invalidation

### Strategy

All slot cache entries are invalidated on any write operation (create, update, delete, soft-delete) to ensure data consistency. This is a "cache-aside" pattern with write-through invalidation.

### Invalidation Process

1. **Pattern Matching**: Use Redis `KEYS` command with pattern `slots:page:*` to find all paginated cache keys
2. **Bulk Deletion**: Delete all matched keys in parallel using `Promise.all`
3. **Legacy Cleanup**: Also delete the legacy `slots:all` key for backward compatibility

### Implementation

```typescript
export async function invalidateSlotsCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    // Delete all paginated slot cache keys
    const keys = await redis.keys(SLOT_CACHE_KEYS.pattern);
    if (keys.length > 0) {
      await Promise.all(keys.map(key => redis.del(key)));
    }
    
    // Also delete legacy key for backward compatibility
    await redis.del(SLOT_CACHE_KEYS.all);
  } catch (err) {
    console.warn("[slotCache] invalidateSlotsCache error:", (err as Error).message);
  }
}
```

### When to Invalidate

Cache invalidation is triggered after:
- **POST** - Creating a new slot
- **PUT** - Updating an existing slot
- **DELETE** - Deleting a slot
- **PATCH** - Soft-deleting a slot

## Security Considerations

### Cache Key Safety

**Cache keys do NOT contain PII or sensitive data:**

- ✅ Safe: `slots:page:1` (resource name + numeric page)
- ✅ Safe: `slots:all` (resource name only)
- ❌ Unsafe: `slots:user:john@example.com` (contains email)
- ❌ Unsafe: `slots:professional:Dr+Smith` (contains PII)

### Pattern Matching Safety

The invalidation pattern `slots:page:*` is safe because:
- It only matches keys that follow our defined schema
- It does not include user input or dynamic values
- The pattern is hardcoded and controlled by the application

### Data in Cache Values

While cache keys are safe, cached values may contain business data:
- Slot data includes professional names and time ranges
- Ensure Redis is secured with authentication
- Use TLS for Redis connections in production
- Consider encryption at rest for sensitive deployments

## Performance Considerations

### KEYS Command Usage

The `KEYS` command is used for cache invalidation. In production with large keyspaces, consider:
- Using `SCAN` instead of `KEYS` for better performance
- Maintaining a separate set of active cache keys
- Implementing cache versioning or namespace invalidation

### TTL Configuration

Default TTL is 60 seconds (configurable via `REDIS_SLOT_TTL_SECONDS`):
- Short TTL reduces stale data risk
- Balances cache hit rate with data freshness
- Adjust based on your application's read/write patterns

## Testing

### Unit Tests

Unit tests in `src/__tests__/slotCache.test.ts` cover:
- Cache hit/miss scenarios
- Error handling (Redis unavailability, malformed JSON)
- Paginated cache operations
- Multi-page invalidation

### Integration Tests

Integration tests in `src/__tests__/slots-cache.test.ts` cover:
- End-to-end cache invalidation on mutations
- Multi-page cache consistency
- Concurrent operations (update+list, delete+restore)
- Edge cases (cache miss after invalidation)

### Test Coverage

Target: 95%+ coverage on cache-related files
- `src/cache/slotCache.ts`
- `src/cache/redisClient.ts`
- `src/__tests__/slotCache.test.ts`
- `src/__tests__/slots-cache.test.ts`

## Migration Guide

### From Legacy to Paginated Cache

If you're using the legacy `slots:all` key:

1. **Update your code** to use `getCachedSlotsPage(page)` instead of `getCachedSlots()`
2. **Update your cache writes** to use `setCachedSlotsPage(page, result)` instead of `setCachedSlots(slots)`
3. **Test thoroughly** with the new paginated approach
4. **Deploy** - the invalidation function handles both keys during transition

### Example Migration

**Before (Legacy):**
```typescript
const slots = await getCachedSlots();
if (!slots) {
  slots = await fetchSlotsFromDB();
  await setCachedSlots(slots);
}
```

**After (Paginated):**
```typescript
const page = 1;
const result = await getCachedSlotsPage(page);
if (!result) {
  result = await fetchPaginatedSlotsFromDB(page, pageSize);
  await setCachedSlotsPage(page, result);
}
```

## Future Enhancements

Potential improvements to consider:

1. **Cache Versioning**: Add version numbers to keys for schema migrations
2. **Tag-based Invalidation**: Use Redis sets for more granular invalidation
3. **Partial Invalidation**: Only invalidate affected pages when possible
4. **Cache Warming**: Pre-populate cache for frequently accessed pages
5. **Metrics**: Add cache hit/miss rate monitoring
6. **SCAN instead of KEYS**: For better performance in large keyspaces

## References

- Implementation: `src/cache/slotCache.ts`
- Redis Client: `src/cache/redisClient.ts`
- Unit Tests: `src/__tests__/slotCache.test.ts`
- Integration Tests: `src/__tests__/slots-cache.test.ts`

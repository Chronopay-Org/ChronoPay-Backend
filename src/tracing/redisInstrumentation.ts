import type { RedisClient } from "../cache/redisClient.js";
import { withSpan } from "./hooks.js";

/**
 * Strip sensitive information from Redis commands for safe logging.
 */
function stripRedisCommand(cmd: string, args: unknown[]): string {
  // Show command and argument count but not values
  return `${cmd.toUpperCase()} (${args.length} args)`.substring(0, 100);
}

/**
 * Wrap a Redis client to automatically wrap commands in spans.
 * Returns a wrapped client that instruments all operations.
 */
export function createInstrumentedRedisClient(client: RedisClient): RedisClient {
  return {
    async get(key: string) {
      return withSpan(
        "cache.get",
        {
          "cache.system": "redis",
          "cache.operation": "GET",
          "cache.key_hash": hashKey(key),
        },
        () => client.get(key),
      );
    },

    async set(key: string, value: string, exMode: "EX", ttl: number, condition?: "NX") {
      return withSpan(
        "cache.set",
        {
          "cache.system": "redis",
          "cache.operation": "SET",
          "cache.key_hash": hashKey(key),
          "cache.ttl": ttl,
          "cache.condition": condition || "none",
        },
        () => client.set(key, value, exMode, ttl, condition),
      );
    },

    async del(key: string) {
      return withSpan(
        "cache.del",
        {
          "cache.system": "redis",
          "cache.operation": "DEL",
          "cache.key_hash": hashKey(key),
        },
        () => client.del(key),
      );
    },

    async keys(pattern: string) {
      return withSpan(
        "cache.keys",
        {
          "cache.system": "redis",
          "cache.operation": "KEYS",
          "cache.pattern": pattern.substring(0, 50),
        },
        () => client.keys(pattern),
      );
    },

    async ping() {
      return withSpan(
        "cache.ping",
        {
          "cache.system": "redis",
          "cache.operation": "PING",
        },
        () => client.ping(),
      );
    },

    async quit() {
      return withSpan(
        "cache.quit",
        {
          "cache.system": "redis",
          "cache.operation": "QUIT",
        },
        () => client.quit(),
      );
    },
  };
}

/**
 * Generate a hash of a key for safe logging (does not leak key values).
 */
function hashKey(key: string): string {
  // Simple hash: just use length and first char as identifier
  return `key_${key.length}_${key.charCodeAt(0)}`;
}

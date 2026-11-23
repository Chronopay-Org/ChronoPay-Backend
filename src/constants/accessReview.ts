/**
 * SOC2 Access Review bounds.
 *
 * Shared by the admin routes, which reject out-of-range query params with
 * 400, and the access-review worker, which clamps its env-configured
 * lookback into the same range.
 */

/** Smallest page size accepted by the access-review list routes. */
export const ACCESS_REVIEW_MIN_LIMIT = 1;

/** Largest page size accepted by the access-review list routes. */
export const ACCESS_REVIEW_MAX_LIMIT = 200;

/** Smallest pagination offset (0 is the first page). */
export const ACCESS_REVIEW_MIN_OFFSET = 0;

/** Fewest quarters of gap history the worker and route will consider. */
export const ACCESS_REVIEW_LOOKBACK_MIN = 1;

/** Most quarters of gap history the worker and route will consider. */
export const ACCESS_REVIEW_LOOKBACK_MAX = 40;

/** Gap-history quarters used when no lookback is given. */
export const ACCESS_REVIEW_LOOKBACK_DEFAULT = 8;

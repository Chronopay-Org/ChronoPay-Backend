# Marketplace Geo-Radius Search

Adds an optional geo-radius filter and distance sort to marketplace slot
search (issue #466), using an H3-indexed prefilter and a precise
great-circle distance cutoff on the candidate set.

## Schema

Migration `014_add_slot_geo_fields` adds three nullable columns to `slots`:

| Column          | Type            | Notes                                              |
|-----------------|-----------------|-----------------------------------------------------|
| `latitude`      | `NUMERIC(9,6)`  | Slot centroid latitude, range [-90, 90]              |
| `longitude`     | `NUMERIC(9,6)`  | Slot centroid longitude, range [-180, 180]           |
| `h3_cell_res7`  | `VARCHAR(20)`   | Precomputed H3 cell (resolution 7, ~1.4km edge)      |

All three are either all `NULL` or all populated together
(`chk_slots_geo_consistency`) — geo data is optional per slot. A partial
index on `h3_cell_res7 WHERE h3_cell_res7 IS NOT NULL` backs the radius
prefilter lookup.

> **Scope note:** this migration adds storage and a reusable
> `computeH3Cell(lat, lng)` helper (`src/services/geo/h3GeoIndex.ts`) for
> populating `h3_cell_res7`, but does not wire slot creation/update
> (`slotService.ts` / `slotRepository.ts`) to populate these columns — that
> write path is outside this issue's named scope
> (`marketplaceSearchService.ts`). It's a small, isolated follow-up: call
> `computeH3Cell` wherever a slot's lat/lng is set and store the result.

## Query API

```jsonc
{
  "geo": { "lat": 37.7749, "lng": -122.4194, "radiusKm": 10 },
  "sortBy": "distance" // or "rating" | "price" | "relevance"
}
```

- `lat` ∈ [-90, 90], `lng` ∈ [-180, 180], `radiusKm` ∈ (0, 100].
- `sortBy: "distance"` requires `geo` to be present.
- `geo` cannot be combined with cursor-based pagination (`cursor`); use
  `page`/`limit` instead. Distance is computed per-request against the exact
  query point, so a stable opaque cursor across pages isn't meaningful the
  way it is for the fixed `rating`/`price`/`relevance` sort keys.
- Results include a `distanceKm` field (rounded to 2 decimals) on every slot
  when `geo` is present.

## How it works

1. **Prefilter (fast, indexed):** the query point's H3 cell (resolution 7)
   is computed, then `gridDisk` expands it to a ring of neighboring cells
   sized to cover the requested radius plus a one-ring buffer. This tile set
   is used as `h3_cell_res7 = ANY($n::text[])` against the partial index.
2. **Precise cutoff + sort (candidate set):** rows matching the prefilter
   (and any other filters — category/price/rating/time/status) are fetched,
   up to `MAX_GEO_CANDIDATES` (5000) rows. Each row's exact great-circle
   distance to the query point is computed (via h3-js's
   `greatCircleDistance`), rows beyond `radiusKm` are dropped, and the
   remainder is sorted per `sortBy` with `id` as the final tiebreaker.
3. Pagination (`page`/`limit`) is applied to the sorted, exact-radius result
   set in application code, and `total` reflects the exact count.

## Correctness at the antimeridian and poles

`gridDisk` and `greatCircleDistance` (from `h3-js`) operate on the H3 grid's
icosahedral topology / 3D unit vectors respectively, not on flat lat/lng
deltas or bounding boxes. This means both the candidate tile expansion and
the exact distance calculation are correct by construction across the ±180°
antimeridian and near the poles — no special-casing was needed. This is
covered directly in `src/services/geo/__tests__/h3GeoIndex.test.ts` (cell
lookups and distances near ±180° longitude and near both poles) and
end-to-end in `src/services/__tests__/marketplaceSearchGeo.test.ts` (a slot
placed just across the dateline from the query point, and one placed near
the North Pole).

## Known trade-offs (intentionally out of scope for this PR)

- **LTR reranking is skipped for geo queries.** The reranker's feature
  vectors don't yet account for distance; extending them is a separate,
  larger change.
- **`MAX_GEO_CANDIDATES` is a flat cap**, not a scalable spatial index
  strategy. If slot density within a ~100km H3 neighborhood ever
  meaningfully exceeds 5000 rows, results are computed from the first
  `MAX_GEO_CANDIDATES` rows the prefilter returns rather than the true full
  set. A PostGIS-backed `ST_DWithin`/`KNN` approach would remove this cap
  but is a materially larger change than this issue calls for.
- **Slot write path is not wired up** (see scope note in the Schema section
  above).

## Tests

- `src/services/geo/__tests__/h3GeoIndex.test.ts` — pure H3 helper
  correctness (determinism, ring sizing, antimeridian, poles, known
  distances).
- `src/validation/__tests__/marketplaceSearchSchemaGeo.test.ts` — schema
  bounds and cross-field validation (`sortBy: "distance"` requires `geo`;
  `geo` + `cursor` rejected).
- `src/services/__tests__/marketplaceSearchGeo.test.ts` — end-to-end via a
  mock pg pool: radius correctness (including prefilter-tile-but-out-of-radius
  exclusion), empty tile, antimeridian/polar cases, all four sort modes with
  tiebreak coverage, combination with other filters, pagination, the
  candidate cap, caching (hit/miss/set-failure), and error handling.

Run just these:

```bash
node --experimental-vm-modules node_modules/jest-cli/bin/jest.js --runInBand \
  --testPathPattern='(marketplaceSearchGeo|h3GeoIndex|marketplaceSearchSchemaGeo)'
```

`src/services/geo/h3GeoIndex.ts` and `src/validation/marketplaceSearchSchema.ts`
are at 100% coverage; the new `searchByGeoRadius`/`sortGeoCandidates` code in
`marketplaceSearchService.ts` is fully covered by the geo test suite (verified
via `--coverage --collectCoverageFrom` scoped to these files).

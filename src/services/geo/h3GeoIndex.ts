/**
 * H3 Geo Index Helpers
 *
 * Pure functions for H3-based geo-radius search:
 *  - Computing the storage-resolution H3 cell for a slot centroid.
 *  - Computing the candidate "tile" set (H3 disk) that a radius search must scan.
 *  - Precise great-circle distance between two coordinates.
 *
 * Design decisions:
 *  - A single fixed storage resolution (RES 7, ~1.4km edge length) is used for
 *    the indexed `h3_cell_res7` column. This keeps the schema simple (single
 *    column + single btree index) while giving city-block-scale granularity,
 *    which is appropriate for marketplace slot search radii (schema caps the
 *    radius at MAX_RADIUS_KM).
 *  - H3's `gridDisk` (not a manual neighbor walk or a flat lat/lng bounding
 *    box) is used to compute the candidate tile set. Because H3 operates on
 *    an icosahedral grid rather than a flat lat/lng plane, this is correct
 *    across the antimeridian (±180° longitude) and near the poles without
 *    any special-casing.
 *  - `greatCircleDistance` (from h3-js) is used for the precise distance
 *    calculation rather than a hand-rolled haversine implementation. It uses
 *    the same underlying spherical trigonometry as haversine, is
 *    battle-tested, and is correct at the antimeridian and poles by
 *    construction (it operates on 3D unit vectors, not raw lng deltas).
 *  - The candidate ring size (`k`) is computed from the requested radius and
 *    the average hex edge length at the storage resolution, plus one buffer
 *    ring. The buffer ring guards against slots that fall within the
 *    requested radius but whose centroid lies in a neighboring cell just
 *    across a hex boundary from the query point's cell. Over-fetching a
 *    slightly larger tile set is safe because the exact haversine/great
 *    circle distance filter below trims the candidate set down to the true
 *    radius; it is never used as the final answer on its own.
 */

import { latLngToCell, gridDisk, greatCircleDistance, getHexagonEdgeLengthAvg } from "h3-js";

/** Fixed H3 resolution used for the indexed `h3_cell_res7` column. */
export const GEO_INDEX_RESOLUTION = 7;

/** Maximum allowed search radius, enforced in the validation schema. */
export const MAX_RADIUS_KM = 100;

/** Hard cap on the number of database rows fetched for a single geo search,
 * to bound worst-case query cost regardless of tile density. */
export const MAX_GEO_CANDIDATES = 5000;

const EDGE_LENGTH_KM = getHexagonEdgeLengthAvg(GEO_INDEX_RESOLUTION, "km");

/**
 * Compute the H3 cell (at the fixed storage resolution) for a slot centroid.
 * Used both when writing slot geo data and when computing the query center cell.
 *
 * @param lat Latitude in degrees, [-90, 90]
 * @param lng Longitude in degrees, [-180, 180]
 * @returns H3 cell index string (e.g. "872830829ffffff")
 */
export function computeH3Cell(lat: number, lng: number): string {
  return latLngToCell(lat, lng, GEO_INDEX_RESOLUTION);
}

/**
 * Compute the number of grid rings needed to cover a given radius, plus a
 * one-ring buffer for cells that straddle the boundary of the center cell.
 *
 * @param radiusKm Search radius in kilometers (must be > 0)
 * @returns Ring size k, always >= 1
 */
export function computeRingSize(radiusKm: number): number {
  return Math.max(1, Math.ceil(radiusKm / EDGE_LENGTH_KM) + 1);
}

/**
 * Compute the set of H3 cells (at the storage resolution) that must be
 * scanned as a prefilter tile set for a radius search centered at (lat, lng).
 *
 * Correct across the antimeridian and at the poles: `gridDisk` walks the H3
 * grid topology rather than a flat lat/lng bounding box, so it has no
 * wraparound or pole-distortion failure mode.
 *
 * @param lat Latitude in degrees, [-90, 90]
 * @param lng Longitude in degrees, [-180, 180]
 * @param radiusKm Search radius in kilometers (must be > 0)
 * @returns Array of H3 cell index strings covering the candidate area
 */
export function computeCandidateCells(lat: number, lng: number, radiusKm: number): string[] {
  const centerCell = computeH3Cell(lat, lng);
  const k = computeRingSize(radiusKm);
  return gridDisk(centerCell, k);
}

/**
 * Precise great-circle distance between two coordinates, in kilometers.
 * Correct at the antimeridian and poles (operates on 3D unit vectors).
 *
 * @param lat1 Latitude of point 1, in degrees
 * @param lng1 Longitude of point 1, in degrees
 * @param lat2 Latitude of point 2, in degrees
 * @param lng2 Longitude of point 2, in degrees
 * @returns Distance in kilometers
 */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return greatCircleDistance([lat1, lng1], [lat2, lng2], "km");
}

/**
 * fraudModelRegistry.ts
 * ----------------------
 * In-process registry for fraud scoring model versions. Stores per-version
 * configuration, validates that promotion requests satisfy the
 * "weights sum to 100" invariant, and exposes an immutable routing snapshot
 * so in-flight requests cannot be affected by a mid-flight promotion.
 *
 * Design constraints
 * ------------------
 * - Synchronous, single-writer. Node's single-threaded execution means
 *   synchronous state reads and writes are atomic with respect to each
 *   other; we don't need an explicit mutex.
 * - Immutable snapshots. Every successful mutate produces a new
 *   `RoutingSnapshot`. The router and scorer always read from a snapshot,
 *   so a promotion cannot tear an in-flight request.
 * - Weights are non-negative integers summing to exactly 100. This bounds
 *   valid input and makes the consistent-hash bucket space (size 100)
 *   trivial to allocate.
 * - Per-tenant overrides are explicit and validated against the registered
 *   versions at the time of promotion. An override whose target version
 *   drops to weight 0 is flagged as a warning and removed from the active
 *   snapshot.
 *
 * Audit
 * -----
 * The registry does NOT emit audit events by itself — that is the
 * responsibility of the calling endpoint so it can include the actor info
 * (admin IP, request id). The endpoint MUST call
 * `defaultAuditLogger.log("FRAUD_MODEL_PROMOTED", ...)` BEFORE invoking
 * `promote(...)` to satisfy the audit-first contract.
 */

import {
  fraudTrafficRouter,
  type RoutingSnapshot,
} from "./fraudTrafficRouter.js";

export interface FraudModelConfig {
  version: string;
  /** SHA-256 hex digest of the canonicalized model config blob. */
  contentHash: string;
  /** Original traffic weight 0–100. Metadata for `listModels`; not used by
   * the router which sources its weights from the active promotion. */
  trafficWeight: number;
  registeredAt: string;
  registeredBy: string;
}

export interface PromotionRequest {
  weights: Record<string, number>;
  tenantOverrides: Record<string, string>;
}

export interface PromotionValidation {
  errors: FraudModelRegistryError[];
  /** Non-fatal conflicts that the caller may want to surface. */
  warnings: OverrideWeightZeroWarning[];
}

export interface PromotionResult {
  snapshot: RoutingSnapshot;
  removedVersions: string[];
  removedOverrides: string[];
  warnings: OverrideWeightZeroWarning[];
}

export class FraudModelRegistryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "FraudModelRegistryError";
  }
}

export class DuplicateVersionError extends FraudModelRegistryError {
  constructor(version: string) {
    super(`Model version ${version} is already registered`, "DUPLICATE_VERSION");
  }
}

export class WeightsDoNotSumError extends FraudModelRegistryError {
  constructor(actual: number) {
    super(
      `Traffic weights must sum to 100 (got ${actual})`,
      "WEIGHTS_DO_NOT_SUM",
    );
  }
}

export class NegativeWeightError extends FraudModelRegistryError {
  constructor(version: string, weight: number) {
    super(
      `Weight for version ${version} must be >= 0 (got ${weight})`,
      "NEGATIVE_WEIGHT",
    );
  }
}

export class NonIntegerWeightError extends FraudModelRegistryError {
  constructor(version: string, weight: number) {
    super(
      `Weight for version ${version} must be an integer in [0,100] (got ${weight})`,
      "NON_INTEGER_WEIGHT",
    );
  }
}

export class UnknownVersionError extends FraudModelRegistryError {
  constructor(version: string) {
    super(`Model version ${version} is not registered`, "UNKNOWN_VERSION");
  }
}

export class InvalidOverrideError extends FraudModelRegistryError {
  constructor(tenantId: string, version: string) {
    super(
      `Override for tenant ${tenantId} references unknown version ${version}`,
      "INVALID_OVERRIDE",
    );
  }
}

export interface OverrideWeightZeroWarning {
  code: "OVERRIDE_TARGET_WEIGHT_ZERO";
  tenantId: string;
  version: string;
  message: string;
}

export class EmptyRegistryError extends FraudModelRegistryError {
  constructor() {
    super("Cannot promote an empty registry", "EMPTY_REGISTRY");
  }
}

interface InternalState {
  models: Map<string, FraudModelConfig>;
  snapshot: RoutingSnapshot;
  /** Monotonic id bumped on every successful mutation. */
  snapshotCounter: number;
}

const WEIGHT_SUM_TOLERANCE = 0; // strict equality

function weightOf(map: Record<string, number>, version: string): number {
  const w = map[version];
  return typeof w === "number" && Number.isFinite(w) ? w : 0;
}

export class FraudModelRegistry {
  private state: InternalState;

  constructor() {
    this.state = {
      models: new Map(),
      snapshotCounter: 0,
      snapshot: {
        snapshotId: "snap-0",
        overrides: new Map(),
        cumulative: [],
        defaultVersion: "",
        versions: new Set(),
      },
    };
  }

  registerModel(config: FraudModelConfig): void {
    if (this.state.models.has(config.version)) {
      throw new DuplicateVersionError(config.version);
    }
    // Light validation on the registry metadata — weight metadata must be
    // an integer in [0,100]. Detailed sum-of-100 enforcement lives in
    // `validateWeights` at promotion time because that's where the full
    // weight plan is known.
    if (!Number.isInteger(config.trafficWeight) || config.trafficWeight < 0 || config.trafficWeight > 100) {
      throw new NonIntegerWeightError(config.version, config.trafficWeight);
    }
    this.state.models.set(config.version, config);
  }

  listModels(): FraudModelConfig[] {
    return Array.from(this.state.models.values()).map((m) => ({ ...m }));
  }

  getModelByVersion(version: string): FraudModelConfig | undefined {
    const m = this.state.models.get(version);
    return m ? { ...m } : undefined;
  }

  /**
   * Pure validation. Returns errors AND non-fatal warnings. Empty errors
   * array == valid promotion. Warnings are surfaced separately so the
   * admin endpoint can include them in the success response.
   */
  validateWeights(
    weights: Record<string, number>,
    tenantOverrides: Record<string, string>,
  ): PromotionValidation {
    const errors: FraudModelRegistryError[] = [];
    const warnings: OverrideWeightZeroWarning[] = [];

    if (this.state.models.size === 0 && Object.keys(weights).length > 0) {
      errors.push(new EmptyRegistryError());
      return { errors, warnings };
    }

    let total = 0;
    let perVersionErrors = 0;
    for (const [version, weight] of Object.entries(weights)) {
      if (!this.state.models.has(version)) {
        errors.push(new UnknownVersionError(version));
        perVersionErrors += 1;
        continue;
      }
      if (!Number.isFinite(weight) || weight < 0) {
        errors.push(new NegativeWeightError(version, weight));
        perVersionErrors += 1;
        continue;
      }
      if (!Number.isInteger(weight) || weight > 100) {
        errors.push(new NonIntegerWeightError(version, weight));
        perVersionErrors += 1;
        continue;
      }
      total += weight;
    }

    // Skip the sum-mismatch check when any per-version weight was already
    // rejected — the operator already knows which entries are wrong, and a
    // spurious WeightsDoNotSum error (with an artificially-low total that
    // skipped the invalid entries) would add noise without new information.
    if (perVersionErrors === 0 && Math.abs(total - 100) > WEIGHT_SUM_TOLERANCE) {
      errors.push(new WeightsDoNotSumError(total));
    }

    for (const [tenantId, version] of Object.entries(tenantOverrides)) {
      if (!this.state.models.has(version)) {
        errors.push(new InvalidOverrideError(tenantId, version));
        continue;
      }
      // Flag overrides whose target version drops to weight 0 as a
      // non-fatal warning so the admin endpoint can surface it.
      if (weightOf(weights, version) <= 0) {
        warnings.push({
          code: "OVERRIDE_TARGET_WEIGHT_ZERO",
          tenantId,
          version,
          message: `Override for tenant ${tenantId} targets ${version} which has weight 0; override will not be applied.`,
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Apply a promotion. Caller MUST emit the audit event before calling.
   * Returns the new snapshot plus the side-effects (versions that fell out
   * of the ranking, overrides that became invalid).
   */
  promote(request: PromotionRequest, _actorId: string): PromotionResult {
    const { errors, warnings } = this.validateWeights(
      request.weights,
      request.tenantOverrides,
    );
    if (errors.length > 0) {
      throw errors[0];
    }

    const nextCounter = this.state.snapshotCounter + 1;

    // `removedOverrides` reports every tenant binding that was active in the
    // *previous* snapshot but will not be active in the new one. The admin
    // endpoint surfaces this list so operators can see exactly which
    // routings fell out of the latest promotion, not just which the new
    // request happened to repeat. Brand-new override entries that target
    // a weight-0 version are NOT included — those entries never activated,
    // so they belong in `warnings` (via OVERRIDE_TARGET_WEIGHT_ZERO), not
    // in a list of bindings that were dropped from an active state.
    const removedOverrides: string[] = [];
    for (const [tenantId, prevVersion] of Array.from(
      this.state.snapshot.overrides.entries(),
    )) {
      const newTarget = request.tenantOverrides[tenantId];
      if (newTarget === undefined) {
        // The tenant is no longer mentioned in the new request at all.
        removedOverrides.push(`${tenantId}->${prevVersion}`);
        continue;
      }
      if (newTarget !== prevVersion) {
        // The tenant was retargeted to a different version — the old
        // binding is gone even if the next binding succeeds.
        removedOverrides.push(`${tenantId}->${prevVersion}`);
        continue;
      }
      if (weightOf(request.weights, prevVersion) <= 0) {
        // Same binding, but the version lost its traffic weight so the
        // override now points off-route.
        removedOverrides.push(`${tenantId}->${prevVersion}`);
      }
    }

    const removedVersions: string[] = [];
    for (const version of this.state.models.keys()) {
      if (weightOf(request.weights, version) <= 0) {
        removedVersions.push(version);
      }
    }

    this.state.snapshotCounter = nextCounter;
    this.state.snapshot = fraudTrafficRouter.buildSnapshot({
      models: this.state.models,
      weights: request.weights,
      overrides: request.tenantOverrides,
      snapshotId: `snap-${nextCounter}`,
    });

    return {
      snapshot: this.state.snapshot,
      removedVersions,
      removedOverrides,
      warnings,
    };
  }

  /** Latest immutable routing snapshot. */
  getLatestSnapshot(): RoutingSnapshot {
    return this.state.snapshot;
  }

  /**
   * Tear-down helper. Test isolation only — never call in production code.
   */
  _reset(): void {
    this.state.models.clear();
    this.state.snapshotCounter = 0;
    this.state.snapshot = fraudTrafficRouter.buildSnapshot({
      models: this.state.models,
      weights: {},
      overrides: {},
      snapshotId: "snap-0",
    });
  }
}

let _singleton: FraudModelRegistry | null = null;

export function getFraudModelRegistry(): FraudModelRegistry {
  if (!_singleton) _singleton = new FraudModelRegistry();
  return _singleton;
}

/** Test isolation only. */
export function resetFraudModelRegistry(): void {
  if (_singleton) _singleton._reset();
  _singleton = null;
}

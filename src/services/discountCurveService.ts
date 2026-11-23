export interface DiscountTier {
  minQuantity: number;
  discountRate: number;
}

export interface StackabilityRule {
  stackable: boolean;
  stackableWith: string[];
  maxStackCount: number;
}

export interface CreateDiscountCurveInput {
  id: string;
  name: string;
  description?: string;
  bundleId: string;
  supplierId: string;
  tiers: DiscountTier[];
  stackability?: Partial<StackabilityRule>;
  active?: boolean;
  validFrom?: number;
  validUntil?: number;
}

export type UpdateDiscountCurveInput = Partial<
  Omit<CreateDiscountCurveInput, "id">
>;

export interface DiscountCurveRecord
  extends Omit<CreateDiscountCurveInput, "stackability" | "active"> {
  stackability: StackabilityRule;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
/**
 * Discount Curve Service
 *
 * Manages discount curves for bundles with min-buy thresholds and stackability rules.
 * Provides CRUD operations and pricing resolution.
 */

import {
  CreateDiscountCurveSchema,
  UpdateDiscountCurveSchema,
  type CreateDiscountCurveInput,
  type CreateDiscountCurveRawInput,
  type UpdateDiscountCurveInput,
  type DiscountTier,
  type AppliedDiscountRecord,
  type BundlePricingContext,
} from "../validation/discountCurveSchema.js";

export type { AppliedDiscountRecord, BundlePricingContext } from "../validation/discountCurveSchema.js";

// ─── Error Classes ────────────────────────────────────────────────────────────

export class DiscountCurveNotFoundError extends Error {
  constructor(id: string) {
    super(`Discount curve not found: ${id}`);
    this.name = "DiscountCurveNotFoundError";
  }
}

export class DiscountCurveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscountCurveValidationError";
  }
}

const store = new Map<string, DiscountCurveRecord>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new DiscountCurveValidationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new DiscountCurveValidationError(`${field} must be an integer`);
  }
  return value;
}

function parseTiers(value: unknown): DiscountTier[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new DiscountCurveValidationError("tiers must contain between 1 and 50 entries");
  }

  const tiers = value.map((tier, index) => {
    if (
      !isRecord(tier) ||
      typeof tier.minQuantity !== "number" ||
      !Number.isInteger(tier.minQuantity) ||
      tier.minQuantity < 1 ||
      typeof tier.discountRate !== "number" ||
      !Number.isFinite(tier.discountRate) ||
      tier.discountRate < 0 ||
      tier.discountRate > 1
    ) {
      throw new DiscountCurveValidationError(`tiers[${index}] is invalid`);
    }

    return {
      minQuantity: tier.minQuantity,
      discountRate: tier.discountRate,
    };
  });

  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index].minQuantity <= tiers[index - 1].minQuantity) {
      throw new DiscountCurveValidationError(
        "Tiers must be sorted by minQuantity in ascending order",
      );
    }
  }

  return tiers;
}

function parseStackability(value: unknown): StackabilityRule {
  if (value === undefined) {
    return { stackable: false, stackableWith: [], maxStackCount: 1 };
  }
  if (!isRecord(value)) {
    throw new DiscountCurveValidationError("stackability must be an object");
  }

  const stackable = value.stackable ?? false;
  const stackableWith = value.stackableWith ?? [];
  const maxStackCount = value.maxStackCount ?? 1;
  if (
    typeof stackable !== "boolean" ||
    !Array.isArray(stackableWith) ||
    !stackableWith.every((id) => typeof id === "string") ||
    typeof maxStackCount !== "number" ||
    !Number.isInteger(maxStackCount) ||
    maxStackCount < 1
  ) {
    throw new DiscountCurveValidationError("stackability is invalid");
  }

  return { stackable, stackableWith, maxStackCount };
}

function parseCreateInput(value: unknown): Omit<
  DiscountCurveRecord,
  "createdAt" | "updatedAt"
> {
  if (!isRecord(value)) {
    throw new DiscountCurveValidationError("Request body must be an object");
  }

  const id = requiredString(value.id, "id", 128);
  const name = requiredString(value.name, "name", 256);
  const bundleId = requiredString(value.bundleId, "bundleId", 128);
  const supplierId = requiredString(value.supplierId, "supplierId", 128);
  const description =
    value.description === undefined
      ? undefined
      : requiredString(value.description, "description", 1024);
  const tiers = parseTiers(value.tiers);
  const stackability = parseStackability(value.stackability);
  const active = value.active ?? true;
  if (typeof active !== "boolean") {
    throw new DiscountCurveValidationError("active must be a boolean");
  }
  const validFrom = optionalTimestamp(value.validFrom, "validFrom");
  const validUntil = optionalTimestamp(value.validUntil, "validUntil");
  if (
    validFrom !== undefined &&
    validUntil !== undefined &&
    validFrom >= validUntil
  ) {
    throw new DiscountCurveValidationError("validFrom must be before validUntil");
  }

  return {
    id,
    name,
    bundleId,
    supplierId,
    tiers,
    stackability,
    active,
    ...(description === undefined ? {} : { description }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

export function createDiscountCurve(input: unknown): DiscountCurveRecord {
  const parsed = parseCreateInput(input);
  if (store.has(parsed.id)) {
    throw new DiscountCurveValidationError(
      `Discount curve with ID ${parsed.id} already exists`,
    );
export class StackabilityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackabilityConflictError";
  }
}

// ─── In-Memory Store ──────────────────────────────────────────────────────────

interface DiscountCurveRecord extends CreateDiscountCurveInput {
  createdAt: number;
  updatedAt: number;
}

const store = new Map<string, DiscountCurveRecord>();

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Find the applicable tier for a given quantity.
 * Returns the highest tier where quantity >= minQuantity.
 */
export function findApplicableTier(tiers: DiscountTier[], quantity: number): DiscountTier | null {
  let applicable: DiscountTier | null = null;

  for (const tier of tiers) {
    if (quantity >= tier.minQuantity) {
      applicable = tier;
    }
  }

  return applicable;
}

/**
 * Check if two discount curves can be stacked together.
 */
export function canStack(curve1: DiscountCurveRecord, curve2Id: string): boolean {
  if (!curve1.stackability.stackable) {
    return false;
  }

  return curve1.stackability.stackableWith.includes(curve2Id);
}

// ─── CRUD Operations ──────────────────────────────────────────────────────────

/**
 * Create a new discount curve.
 */
export function createDiscountCurve(input: CreateDiscountCurveRawInput): DiscountCurveRecord {
  const parsed = CreateDiscountCurveSchema.safeParse(input);

  if (!parsed.success) {
    const details = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new DiscountCurveValidationError(`Validation failed: ${details}`);
  }

  const data = parsed.data;

  if (store.has(data.id)) {
    throw new DiscountCurveValidationError(`Discount curve with ID ${data.id} already exists`);
  }

  const now = Date.now();
  const record: DiscountCurveRecord = {
    ...parsed,
    createdAt: now,
    updatedAt: now,
  };
  store.set(record.id, record);
  return record;
}

export function getDiscountCurve(id: string): DiscountCurveRecord {
  const curve = store.get(id);
  if (!curve) throw new DiscountCurveNotFoundError(id);
  return curve;
}

    ...data,
    createdAt: now,
    updatedAt: now,
  };

  store.set(data.id, record);
  return record;
}

/**
 * Get a discount curve by ID.
 */
export function getDiscountCurve(id: string): DiscountCurveRecord {
  const record = store.get(id);
  if (!record) {
    throw new DiscountCurveNotFoundError(id);
  }
  return record;
}

/**
 * List all discount curves with optional filtering.
 */
export function listDiscountCurves(options?: {
  supplierId?: string;
  bundleId?: string;
  active?: boolean;
}): DiscountCurveRecord[] {
  return Array.from(store.values()).filter(
    (curve) =>
      (options?.supplierId === undefined ||
        curve.supplierId === options.supplierId) &&
      (options?.bundleId === undefined || curve.bundleId === options.bundleId) &&
      (options?.active === undefined || curve.active === options.active),
  );
}

export function updateDiscountCurve(
  id: string,
  input: unknown,
): DiscountCurveRecord {
  const existing = getDiscountCurve(id);
  if (!isRecord(input)) {
    throw new DiscountCurveValidationError("Request body must be an object");
  }

  const candidate = { ...existing, ...input, id: existing.id };
  const parsed = parseCreateInput(candidate);
  const updated: DiscountCurveRecord = {
    ...parsed,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  let results = Array.from(store.values());

  if (options?.supplierId) {
    results = results.filter((r) => r.supplierId === options.supplierId);
  }

  if (options?.bundleId) {
    results = results.filter((r) => r.bundleId === options.bundleId);
  }

  if (options?.active !== undefined) {
    results = results.filter((r) => r.active === options.active);
  }

  return results;
}

/**
 * Update an existing discount curve.
 */
export function updateDiscountCurve(
  id: string,
  input: UpdateDiscountCurveInput,
): DiscountCurveRecord {
  const existing = store.get(id);
  if (!existing) {
    throw new DiscountCurveNotFoundError(id);
  }

  const parsed = UpdateDiscountCurveSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new DiscountCurveValidationError(`Validation failed: ${details}`);
  }

  const updated: DiscountCurveRecord = {
    ...existing,
    ...parsed.data,
    updatedAt: Date.now(),
  };

  store.set(id, updated);
  return updated;
}

export function deleteDiscountCurve(id: string): void {
  if (!store.delete(id)) throw new DiscountCurveNotFoundError(id);
}

export function resetStore(): void {
  store.clear();
}
/**
 * Delete a discount curve.
 */
export function deleteDiscountCurve(id: string): void {
  if (!store.has(id)) {
    throw new DiscountCurveNotFoundError(id);
  }
  store.delete(id);
}

/**
 * Reset store (for testing only).
 */
export function resetStore(): void {
  store.clear();
}

// ─── Pricing Resolution ───────────────────────────────────────────────────────

/**
 * Resolve the discount for a bundle pricing context.
 * Returns the applied discount record with audit information.
 */
export function resolveBundleDiscount(context: BundlePricingContext): AppliedDiscountRecord {
  const {
    bundleId,
    supplierId,
    quantity,
    basePricePerUnit,
    activeDiscountIds = [],
  } = context;

  // Find all active discount curves for this bundle/supplier
  const curves = listDiscountCurves({
    bundleId,
    supplierId,
    active: true,
  });

  if (curves.length === 0) {
    // No discounts available
    return {
      discountCurveId: "",
      appliedTier: { minQuantity: 0, discountRate: 0 },
      originalPrice: basePricePerUnit * quantity,
      discountAmount: 0,
      finalPrice: basePricePerUnit * quantity,
      wasStacked: false,
      stackedWith: [],
      appliedAt: Date.now(),
    };
  }

  // Find the best applicable discount
  let bestCurve: DiscountCurveRecord | null = null;
  let bestTier: DiscountTier | null = null;
  let bestDiscountRate = 0;

  for (const curve of curves) {
    const tier = findApplicableTier(curve.tiers, quantity);
    if (tier && tier.discountRate > bestDiscountRate) {
      bestCurve = curve;
      bestTier = tier;
      bestDiscountRate = tier.discountRate;
    }
  }

  if (!bestCurve || !bestTier) {
    // No applicable tier found (min-buy not met)
    return {
      discountCurveId: "",
      appliedTier: { minQuantity: 0, discountRate: 0 },
      originalPrice: basePricePerUnit * quantity,
      discountAmount: 0,
      finalPrice: basePricePerUnit * quantity,
      wasStacked: false,
      stackedWith: [],
      appliedAt: Date.now(),
    };
  }

  // Check stackability
  const stackedWith: string[] = [];
  let totalDiscountRate = bestTier.discountRate;

  if (bestCurve.stackability.stackable && activeDiscountIds.length > 0) {
    for (const otherId of activeDiscountIds) {
      if (otherId === bestCurve.id) continue;

      const otherCurve = store.get(otherId);
      if (!otherCurve || !otherCurve.active) continue;

      if (canStack(bestCurve, otherId) && canStack(otherCurve, bestCurve.id)) {
        const otherTier = findApplicableTier(otherCurve.tiers, quantity);
        if (otherTier) {
          stackedWith.push(otherId);
          totalDiscountRate += otherTier.discountRate;

          // Respect max stack count
          if (stackedWith.length >= bestCurve.stackability.maxStackCount) {
            break;
          }
        }
      }
    }

    // Cap total discount at 100%
    totalDiscountRate = Math.min(totalDiscountRate, 1);
  }

  const originalPrice = basePricePerUnit * quantity;
  const discountAmount = Math.round(originalPrice * totalDiscountRate);
  const finalPrice = originalPrice - discountAmount;

  return {
    discountCurveId: bestCurve.id,
    appliedTier: bestTier,
    originalPrice,
    discountAmount,
    finalPrice,
    wasStacked: stackedWith.length > 0,
    stackedWith,
    appliedAt: Date.now(),
  };
}

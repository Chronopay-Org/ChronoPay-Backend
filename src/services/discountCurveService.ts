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

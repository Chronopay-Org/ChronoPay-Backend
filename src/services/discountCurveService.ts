/**
 * Discount Curve Service
 *
 * Manages discount curves for bundles with min-buy thresholds and stackability rules.
 * Provides CRUD operations and pricing resolution.
 */

import {
  CreateDiscountCurveSchema,
  UpdateDiscountCurveSchema,
  type CreateDiscountCurveRawInput,
  type UpdateDiscountCurveInput,
  type DiscountTier,
  type StackabilityRule,
  type AppliedDiscountRecord,
  type BundlePricingContext,
} from "../validation/discountCurveSchema.js";
import {
  DiscountCurveAlreadyExistsError,
  InMemoryDiscountCurveRepository,
  type DiscountCurveFilters,
  type DiscountCurveRecord,
  type DiscountCurveRepository,
} from "../modules/discount-curves/discount-curve-repository.js";
import { defaultDiscountCurveRepository } from "../modules/discount-curves/pg-discount-curve-repository.js";

export type {
  AppliedDiscountRecord,
  BundlePricingContext,
  DiscountTier,
  StackabilityRule,
  UpdateDiscountCurveInput,
} from "../validation/discountCurveSchema.js";
export type { DiscountCurveRecord } from "../modules/discount-curves/discount-curve-repository.js";

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

let repository: DiscountCurveRepository = defaultDiscountCurveRepository;

export function setDiscountCurveRepository(
  discountCurveRepository: DiscountCurveRepository,
): void {
  repository = discountCurveRepository;
}

function validationDetails(error: { errors: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.errors
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(", ");
}

export function findApplicableTier(
  tiers: DiscountTier[],
  quantity: number,
): DiscountTier | null {
  let applicable: DiscountTier | null = null;
  for (const tier of tiers) {
    if (quantity >= tier.minQuantity) applicable = tier;
  }
  return applicable;
}

export function canStack(
  curve: DiscountCurveRecord,
  otherCurveId: string,
): boolean {
  return (
    curve.stackability.stackable &&
    curve.stackability.stackableWith.includes(otherCurveId)
  );
}

export async function createDiscountCurve(
  input: CreateDiscountCurveRawInput,
): Promise<DiscountCurveRecord> {
  const parsed = CreateDiscountCurveSchema.safeParse(input);
  if (!parsed.success) {
    throw new DiscountCurveValidationError(
      `Validation failed: ${validationDetails(parsed.error)}`,
    );
  }

  const now = Date.now();
  const record: DiscountCurveRecord = {
    ...parsed.data,
    createdAt: now,
    updatedAt: now,
  };

  try {
    return await repository.create(record);
  } catch (error) {
    if (error instanceof DiscountCurveAlreadyExistsError) {
      throw new DiscountCurveValidationError(error.message);
    }
    throw error;
  }
}

export async function getDiscountCurve(
  id: string,
): Promise<DiscountCurveRecord> {
  const curve = await repository.findById(id);
  if (!curve) throw new DiscountCurveNotFoundError(id);
  return curve;
}

export function listDiscountCurves(
  options?: DiscountCurveFilters,
): Promise<DiscountCurveRecord[]> {
  return repository.list(options);
}

export async function updateDiscountCurve(
  id: string,
  input: UpdateDiscountCurveInput,
): Promise<DiscountCurveRecord> {
  const existing = await getDiscountCurve(id);
  const parsed = UpdateDiscountCurveSchema.safeParse(input);
  if (!parsed.success) {
    throw new DiscountCurveValidationError(
      `Validation failed: ${validationDetails(parsed.error)}`,
    );
  }

  const validatedRecord = CreateDiscountCurveSchema.safeParse({
    ...existing,
    ...parsed.data,
  });
  if (!validatedRecord.success) {
    throw new DiscountCurveValidationError(
      `Validation failed: ${validationDetails(validatedRecord.error)}`,
    );
  }

  const candidate = {
    ...validatedRecord.data,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  const updated = await repository.update(id, candidate);
  if (!updated) throw new DiscountCurveNotFoundError(id);
  return updated;
}

export async function deleteDiscountCurve(id: string): Promise<void> {
  if (!(await repository.delete(id))) {
    throw new DiscountCurveNotFoundError(id);
  }
}

export function resetStore(): void {
  repository = new InMemoryDiscountCurveRepository();
}

function noDiscount(
  context: BundlePricingContext,
): AppliedDiscountRecord {
  const originalPrice = context.basePricePerUnit * context.quantity;
  return {
    discountCurveId: "",
    appliedTier: { minQuantity: 0, discountRate: 0 },
    originalPrice,
    discountAmount: 0,
    finalPrice: originalPrice,
    wasStacked: false,
    stackedWith: [],
    appliedAt: Date.now(),
  };
}

export async function resolveBundleDiscount(
  context: BundlePricingContext,
): Promise<AppliedDiscountRecord> {
  const { bundleId, supplierId, quantity, basePricePerUnit } = context;
  const curves = await repository.list({
    bundleId,
    supplierId,
    active: true,
  });

  let bestCurve: DiscountCurveRecord | undefined;
  let bestTier: DiscountTier | null = null;
  for (const curve of curves) {
    const tier = findApplicableTier(curve.tiers, quantity);
    if (tier && (!bestTier || tier.discountRate > bestTier.discountRate)) {
      bestCurve = curve;
      bestTier = tier;
    }
  }
  if (!bestCurve || !bestTier) return noDiscount(context);

  const activeDiscountIds = context.activeDiscountIds ?? [];
  const stackedWith: string[] = [];
  let totalDiscountRate = bestTier.discountRate;
  if (bestCurve.stackability.stackable && activeDiscountIds.length > 0) {
    const activeCurves = await repository.list({ active: true });
    const curvesById = new Map(activeCurves.map((curve) => [curve.id, curve]));

    for (const otherId of activeDiscountIds) {
      if (otherId === bestCurve.id) continue;
      const otherCurve = curvesById.get(otherId);
      if (
        !otherCurve ||
        !canStack(bestCurve, otherId) ||
        !canStack(otherCurve, bestCurve.id)
      ) {
        continue;
      }

      const otherTier = findApplicableTier(otherCurve.tiers, quantity);
      if (!otherTier) continue;
      stackedWith.push(otherId);
      totalDiscountRate += otherTier.discountRate;
      if (stackedWith.length >= bestCurve.stackability.maxStackCount) break;
    }
    totalDiscountRate = Math.min(totalDiscountRate, 1);
  }

  const originalPrice = basePricePerUnit * quantity;
  const discountAmount = Math.round(originalPrice * totalDiscountRate);
  return {
    discountCurveId: bestCurve.id,
    appliedTier: bestTier,
    originalPrice,
    discountAmount,
    finalPrice: originalPrice - discountAmount,
    wasStacked: stackedWith.length > 0,
    stackedWith,
    appliedAt: Date.now(),
  };
}

import type {
  DiscountTier,
  StackabilityRule,
} from "../../validation/discountCurveSchema.js";

export interface DiscountCurveRecord {
  id: string;
  name: string;
  description?: string;
  bundleId: string;
  supplierId: string;
  tiers: DiscountTier[];
  stackability: StackabilityRule;
  active: boolean;
  validFrom?: number;
  validUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DiscountCurveFilters {
  supplierId?: string;
  bundleId?: string;
  active?: boolean;
}

export interface DiscountCurveRepository {
  create(curve: DiscountCurveRecord): Promise<DiscountCurveRecord>;
  findById(id: string): Promise<DiscountCurveRecord | undefined>;
  list(filters?: DiscountCurveFilters): Promise<DiscountCurveRecord[]>;
  update(
    id: string,
    curve: DiscountCurveRecord,
  ): Promise<DiscountCurveRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export class DiscountCurveAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`Discount curve with ID ${id} already exists`);
    this.name = "DiscountCurveAlreadyExistsError";
  }
}

function cloneCurve(curve: DiscountCurveRecord): DiscountCurveRecord {
  return {
    ...curve,
    tiers: curve.tiers.map((tier) => ({ ...tier })),
    stackability: {
      ...curve.stackability,
      stackableWith: [...curve.stackability.stackableWith],
    },
  };
}

export class InMemoryDiscountCurveRepository
  implements DiscountCurveRepository
{
  private readonly curves = new Map<string, DiscountCurveRecord>();

  async create(curve: DiscountCurveRecord): Promise<DiscountCurveRecord> {
    if (this.curves.has(curve.id)) {
      throw new DiscountCurveAlreadyExistsError(curve.id);
    }
    this.curves.set(curve.id, cloneCurve(curve));
    return cloneCurve(curve);
  }

  async findById(id: string): Promise<DiscountCurveRecord | undefined> {
    const curve = this.curves.get(id);
    return curve ? cloneCurve(curve) : undefined;
  }

  async list(
    filters: DiscountCurveFilters = {},
  ): Promise<DiscountCurveRecord[]> {
    return Array.from(this.curves.values())
      .filter(
        (curve) =>
          (filters.supplierId === undefined ||
            curve.supplierId === filters.supplierId) &&
          (filters.bundleId === undefined ||
            curve.bundleId === filters.bundleId) &&
          (filters.active === undefined || curve.active === filters.active),
      )
      .map(cloneCurve);
  }

  async update(
    id: string,
    curve: DiscountCurveRecord,
  ): Promise<DiscountCurveRecord | undefined> {
    if (!this.curves.has(id)) return undefined;
    this.curves.set(id, cloneCurve(curve));
    return cloneCurve(curve);
  }

  async delete(id: string): Promise<boolean> {
    return this.curves.delete(id);
  }
}

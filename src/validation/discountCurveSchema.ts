import { z } from "zod";

/**
 * Discount Curve Schema
 *
 * Defines discount tiers for bundles with min-buy thresholds and stackability rules.
 * Stackability must be explicit and defaults to off.
 */

// ─── Tier Schema ──────────────────────────────────────────────────────────────

const DiscountTierSchema = z.object({
  /** Minimum quantity to qualify for this tier (inclusive). Must be ≥ 1. */
  minQuantity: z.number().int().min(1),
  /** Discount percentage as a decimal (0.0 = 0%, 0.5 = 50%, 1.0 = 100%). Must be in [0, 1]. */
  discountRate: z.number().min(0).max(1),
});

// ─── Stackability Rules ───────────────────────────────────────────────────────

const StackabilityRuleSchema = z.object({
  /** Whether this discount can be stacked with other promotions. Defaults to false. */
  stackable: z.boolean().default(false),
  /** List of discount curve IDs that this discount can stack with (if stackable is true). */
  stackableWith: z.array(z.string()).default([]),
  /** Maximum number of stackable discounts that can be applied. Defaults to 1. */
  maxStackCount: z.number().int().min(1).default(1),
});

// ─── Main Discount Curve Schema ───────────────────────────────────────────────

const CreateDiscountCurveBaseSchema = z.object({
  /** Unique identifier for the discount curve. */
  id: z.string().min(1).max(128),
  /** Human-readable name for this discount curve. */
  name: z.string().min(1).max(256),
  /** Description of the discount curve purpose. */
  description: z.string().max(1024).optional(),
  /** The bundle or product ID this discount applies to. */
  bundleId: z.string().min(1).max(128),
  /** Supplier ID who owns this discount curve. */
  supplierId: z.string().min(1).max(128),
  /** Ordered list of discount tiers (sorted by minQuantity ascending). */
  tiers: z.array(DiscountTierSchema).min(1).max(50),
  /** Stackability rules. Defaults to stackable: false. */
  stackability: StackabilityRuleSchema.default({
    stackable: false,
    stackableWith: [],
    maxStackCount: 1,
  }),
  /** Whether this discount curve is currently active. Defaults to true. */
  active: z.boolean().default(true),
  /** Optional start time (Unix epoch ms) when this discount becomes valid. */
  validFrom: z.number().int().optional(),
  /** Optional end time (Unix epoch ms) when this discount expires. */
  validUntil: z.number().int().optional(),
});

export const CreateDiscountCurveSchema = CreateDiscountCurveBaseSchema.refine(
  (data) => {
    // Validate tiers are sorted by minQuantity ascending
    for (let i = 1; i < data.tiers.length; i++) {
      if (data.tiers[i].minQuantity <= data.tiers[i - 1].minQuantity) {
        return false;
      }
    }
    return true;
  },
  {
    message: "Tiers must be sorted by minQuantity in ascending order",
    path: ["tiers"],
  },
).refine(
  (data) => {
    // Validate validFrom < validUntil if both are provided
    if (data.validFrom !== undefined && data.validUntil !== undefined) {
      return data.validFrom < data.validUntil;
    }
    return true;
  },
  {
    message: "validFrom must be before validUntil",
    path: ["validUntil"],
  },
);

export const UpdateDiscountCurveSchema = CreateDiscountCurveBaseSchema.partial().omit({ id: true });

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiscountTier = z.infer<typeof DiscountTierSchema>;
export type StackabilityRule = z.infer<typeof StackabilityRuleSchema>;
export type CreateDiscountCurveInput = z.infer<typeof CreateDiscountCurveSchema>;
/** Raw input type with defaulted fields optional (before Zod parsing). */
export type CreateDiscountCurveRawInput = z.input<typeof CreateDiscountCurveSchema>;
export type UpdateDiscountCurveInput = z.infer<typeof UpdateDiscountCurveSchema>;

// ─── Applied Discount Audit Record ────────────────────────────────────────────

export interface AppliedDiscountRecord {
  /** The discount curve ID that was applied. */
  discountCurveId: string;
  /** The tier that was applied. */
  appliedTier: DiscountTier;
  /** The original base price before discount. */
  originalPrice: number;
  /** The discount amount applied. */
  discountAmount: number;
  /** The final price after discount. */
  finalPrice: number;
  /** Whether this discount was stacked with others. */
  wasStacked: boolean;
  /** IDs of other discounts this was stacked with. */
  stackedWith: string[];
  /** Timestamp when the discount was applied. */
  appliedAt: number;
}

// ─── Pricing Context ──────────────────────────────────────────────────────────

export interface BundlePricingContext {
  /** The bundle ID being priced. */
  bundleId: string;
  /** The supplier ID. */
  supplierId: string;
  /** Number of units being purchased. */
  quantity: number;
  /** Base price per unit in smallest currency unit. */
  basePricePerUnit: number;
  /** Optional: IDs of other discounts to check stackability against. */
  activeDiscountIds?: string[];
}

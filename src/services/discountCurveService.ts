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
  store.set(id, updated);
  return updated;
}

export function deleteDiscountCurve(id: string): void {
  if (!store.delete(id)) throw new DiscountCurveNotFoundError(id);
}

export function resetStore(): void {
  store.clear();
}

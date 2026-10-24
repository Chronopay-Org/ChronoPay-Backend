export interface SubscriptionProductRecord {
  id: string;
  name: string;
  description: string | null;
  professional: string;
  slotDurationMs: number;
  recurrenceRule: string;
  timezone: string;
  priceCents: number;
  currency: string;
  maxSubscribers: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionProductRepository {
  create(product: Omit<SubscriptionProductRecord, "id" | "createdAt" | "updatedAt">): SubscriptionProductRecord;
  findById(productId: string): SubscriptionProductRecord | undefined;
  listByProfessional(professional: string): SubscriptionProductRecord[];
  listActive(): SubscriptionProductRecord[];
  update(productId: string, updates: Partial<Omit<SubscriptionProductRecord, "id" | "createdAt">>): SubscriptionProductRecord;
  delete(productId: string): boolean;
}

export class InMemorySubscriptionProductRepository implements SubscriptionProductRepository {
  private readonly products: SubscriptionProductRecord[] = [];
  private sequence = 1;

  create(input: Omit<SubscriptionProductRecord, "id" | "createdAt" | "updatedAt">): SubscriptionProductRecord {
    const now = new Date().toISOString();
    const product: SubscriptionProductRecord = {
      id: `sp-${this.sequence++}`,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.products.push(product);
    return { ...product };
  }

  findById(productId: string): SubscriptionProductRecord | undefined {
    const product = this.products.find((p) => p.id === productId);
    return product ? { ...product } : undefined;
  }

  listByProfessional(professional: string): SubscriptionProductRecord[] {
    return this.products
      .filter((p) => p.professional === professional)
      .map((p) => ({ ...p }));
  }

  listActive(): SubscriptionProductRecord[] {
    return this.products
      .filter((p) => p.active)
      .map((p) => ({ ...p }));
  }

  update(productId: string, updates: Partial<Omit<SubscriptionProductRecord, "id" | "createdAt">>): SubscriptionProductRecord {
    const index = this.products.findIndex((p) => p.id === productId);
    if (index === -1) {
      throw new Error(`SubscriptionProduct ${productId} not found`);
    }
    this.products[index] = {
      ...this.products[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    return { ...this.products[index] };
  }

  delete(productId: string): boolean {
    const index = this.products.findIndex((p) => p.id === productId);
    if (index === -1) return false;
    this.products.splice(index, 1);
    return true;
  }
}

export interface FxRateProvider {
  getRate(base: string, target: string): Promise<number>;
}

export class InMemoryFxRateProvider implements FxRateProvider {
  private rates: Record<string, Record<string, number>>;

  constructor(rates?: Record<string, Record<string, number>>) {
    this.rates = rates || {
      USD: { EUR: 0.92, GBP: 0.79, XLM: 10.5 },
      EUR: { USD: 1.09, GBP: 0.86, XLM: 11.4 },
      GBP: { USD: 1.27, EUR: 1.16, XLM: 13.3 },
      XLM: { USD: 0.095, EUR: 0.088, GBP: 0.075 },
    };
  }

  async getRate(base: string, target: string): Promise<number> {
    if (base === target) return 1.0;
    const rate = this.rates[base]?.[target];
    if (!rate) {
      throw new Error(`Stale FX provider triggers a typed error, never silent default`);
    }
    return rate;
  }
}

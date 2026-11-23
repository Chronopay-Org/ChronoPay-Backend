export interface BookingLeg {
  legId: string;
  basePrice: number; // Smallest unit, e.g., cents
  currency: string;
  taxRate: number; // e.g., 0.20 for 20%
  isTaxExempt: boolean;
  supplierId: string;
  jurisdiction: string;
}

export interface LegLineItem {
  legId: string;
  supplierId: string;
  jurisdiction: string;
  basePrice: number;
  currency: string;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
}

export interface CurrencyTotals {
  currency: string;
  totalBasePrice: number;
  totalTax: number;
  grandTotal: number;
}

export interface CombinedReceipt {
  legLineItems: LegLineItem[];
  totalsByCurrency: Record<string, CurrencyTotals>;
}

export class MultiLegAggregator {
  /**
   * Aggregates multiple booking legs into a single combined receipt.
   * Handles per-leg tax calculation, rounding safety, tax exemption,
   * and groups totals by currency.
   */
  static generateReceipt(legs: BookingLeg[]): CombinedReceipt {
    const legLineItems: LegLineItem[] = [];
    const totalsByCurrency: Record<string, CurrencyTotals> = {};

    for (const leg of legs) {
      if (leg.basePrice < 0 || !Number.isInteger(leg.basePrice)) {
        throw new Error(`Invalid base price for leg ${leg.legId}: must be a non-negative integer`);
      }
      if (leg.taxRate < 0) {
        throw new Error(`Invalid tax rate for leg ${leg.legId}: must be non-negative`);
      }

      const currency = leg.currency.toUpperCase();
      const taxRate = leg.isTaxExempt ? 0 : leg.taxRate;
      
      // Calculate per-leg tax with rounding safety to prevent drift
      const taxAmount = Math.round(leg.basePrice * taxRate);
      const totalAmount = leg.basePrice + taxAmount;

      legLineItems.push({
        legId: leg.legId,
        supplierId: leg.supplierId,
        jurisdiction: leg.jurisdiction,
        basePrice: leg.basePrice,
        currency,
        taxRate,
        taxAmount,
        totalAmount,
      });

      if (!totalsByCurrency[currency]) {
        totalsByCurrency[currency] = {
          currency,
          totalBasePrice: 0,
          totalTax: 0,
          grandTotal: 0,
        };
      }

      totalsByCurrency[currency].totalBasePrice += leg.basePrice;
      totalsByCurrency[currency].totalTax += taxAmount;
      totalsByCurrency[currency].grandTotal += totalAmount;
    }

    return {
      legLineItems,
      totalsByCurrency,
    };
  }
}

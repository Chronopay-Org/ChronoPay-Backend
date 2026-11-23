import { MultiLegAggregator, BookingLeg } from '../multiLegAggregator.js';

describe('MultiLegAggregator', () => {
  it('should calculate totals correctly for a single leg', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 1000,
        currency: 'USD',
        taxRate: 0.1,
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      }
    ];

    const receipt = MultiLegAggregator.generateReceipt(legs);
    
    expect(receipt.legLineItems).toHaveLength(1);
    expect(receipt.legLineItems[0].taxAmount).toBe(100);
    expect(receipt.legLineItems[0].totalAmount).toBe(1100);
    
    expect(receipt.totalsByCurrency['USD'].totalBasePrice).toBe(1000);
    expect(receipt.totalsByCurrency['USD'].totalTax).toBe(100);
    expect(receipt.totalsByCurrency['USD'].grandTotal).toBe(1100);
  });

  it('should handle tax exempt jurisdictions', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 1000,
        currency: 'USD',
        taxRate: 0.1,
        isTaxExempt: true,
        supplierId: 'sup-1',
        jurisdiction: 'OR',
      }
    ];

    const receipt = MultiLegAggregator.generateReceipt(legs);
    
    expect(receipt.legLineItems[0].taxAmount).toBe(0);
    expect(receipt.legLineItems[0].totalAmount).toBe(1000);
    expect(receipt.totalsByCurrency['USD'].totalTax).toBe(0);
  });

  it('should group totals by mixed currencies', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 1000,
        currency: 'USD',
        taxRate: 0.1,
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      },
      {
        legId: 'leg-2',
        basePrice: 2000,
        currency: 'EUR',
        taxRate: 0.2,
        isTaxExempt: false,
        supplierId: 'sup-2',
        jurisdiction: 'FR',
      },
      {
        legId: 'leg-3',
        basePrice: 500,
        currency: 'USD',
        taxRate: 0.05,
        isTaxExempt: false,
        supplierId: 'sup-3',
        jurisdiction: 'CA',
      }
    ];

    const receipt = MultiLegAggregator.generateReceipt(legs);
    
    expect(Object.keys(receipt.totalsByCurrency)).toHaveLength(2);
    
    expect(receipt.totalsByCurrency['USD'].totalBasePrice).toBe(1500);
    expect(receipt.totalsByCurrency['USD'].totalTax).toBe(125); // 100 + 25
    expect(receipt.totalsByCurrency['USD'].grandTotal).toBe(1625);

    expect(receipt.totalsByCurrency['EUR'].totalBasePrice).toBe(2000);
    expect(receipt.totalsByCurrency['EUR'].totalTax).toBe(400);
    expect(receipt.totalsByCurrency['EUR'].grandTotal).toBe(2400);
  });

  it('should handle rounding drift safely', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 100, // cents
        currency: 'USD',
        taxRate: 0.075, // 7.5% tax -> 7.5 cents -> rounds to 8 cents
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      },
      {
        legId: 'leg-2',
        basePrice: 100, // cents
        currency: 'USD',
        taxRate: 0.075, // rounds to 8 cents
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      }
    ];

    const receipt = MultiLegAggregator.generateReceipt(legs);
    
    // Each leg tax is rounded to 8 cents
    expect(receipt.legLineItems[0].taxAmount).toBe(8);
    expect(receipt.legLineItems[1].taxAmount).toBe(8);
    
    // Aggregate is sum of rounded taxes, not round(sum of unrounded taxes)
    // If it was round(200 * 0.075) = 15. But safe aggregation sum(rounded) = 16.
    expect(receipt.totalsByCurrency['USD'].totalTax).toBe(16);
    expect(receipt.totalsByCurrency['USD'].grandTotal).toBe(216);
  });

  it('should throw an error for negative base price', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: -100,
        currency: 'USD',
        taxRate: 0.1,
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      }
    ];

    expect(() => MultiLegAggregator.generateReceipt(legs)).toThrow('Invalid base price for leg leg-1: must be a non-negative integer');
  });

  it('should throw an error for non-integer base price', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 100.5,
        currency: 'USD',
        taxRate: 0.1,
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      }
    ];

    expect(() => MultiLegAggregator.generateReceipt(legs)).toThrow('Invalid base price for leg leg-1: must be a non-negative integer');
  });

  it('should throw an error for negative tax rate', () => {
    const legs: BookingLeg[] = [
      {
        legId: 'leg-1',
        basePrice: 100,
        currency: 'USD',
        taxRate: -0.1,
        isTaxExempt: false,
        supplierId: 'sup-1',
        jurisdiction: 'NY',
      }
    ];

    expect(() => MultiLegAggregator.generateReceipt(legs)).toThrow('Invalid tax rate for leg leg-1: must be non-negative');
  });
});

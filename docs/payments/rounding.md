# Rounding Rules and Payment Computations

This document describes the unified strategy utilized across ChronoPay to securely compute totals, fees, and validate session amounts effectively.

## 1. Core Rule: No Floats in Checkout Payloads
It is notoriously easy to lose precision when adding or multiplying floating-point numerical types (`0.1 + 0.2 = 0.30000000000000004`). ChronoPay enforces strict minor-unit representation for amounts.

* **Fractions are strictly disallowed**. The API boundary natively checks that checkout quantities are positive, distinct **integers**.
* If a payload defines `payment.amount: 1050` with currency `USD`, that directly establishes a total value of `$10.50`.
* Float representations via strings (e.g., `"10.50"`) are **denied completely** at the boundary middleware. Clients MUST pre-calculate and submit native minor units.

## 2. Integer Boundary Checking
Values undergo hard range bounds validation before logic processing.
* **Positive Requirement**: Values must be `> 0`.
* **Safe Maximum Limit**: Values cannot exceed `$100 Trillion` minor units natively (`1e14`). This caps overflow possibilities while satisfying extremely large crypto payments seamlessly.

## 3. Threat Model Protected: Fractional Underpayments
Payment systems relying directly on float rounding might fall victim to repeated truncation attacks during logic updates.
* **Example Vulnerability**: A user injects an itemized quantity causing `$0.004` (acting effectively as a free micro-computation logic bypass). If enough quantities are queued, a valid `$1.00` total resolves down identically.
* **Prevention Methodology**: 
   Since all amounts rest natively on integer primitives (`AmountUtils`), decimals technically do not physically exist in system logic. It's impossible for fractional pennies to circumvent bounds logically because inputs are explicitly rejected off integers.

## 4. Basis Point Fee Formatting
ChronoPay derives percentages correctly manipulating Basis Points natively inside integer divisions.
* E.X. `150 bps` = `1.5%`.
```typescript
const feeBase = (amount * bps) / 10000;
const computedFee = Math.round(feeBase);
```
Standard generic rounding via `Math.round()` executes deterministically half-up scaling safely because the division relies on strict integer precedents before truncation. The resulting fee generated preserves 100% integrities locally, identical across nodes deterministically.

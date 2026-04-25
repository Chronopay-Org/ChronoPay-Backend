# Checkout Session API Validation

## Overview

This document specifies the strict validation rules for the Checkout Session API, particularly focusing on amounts and Stellar asset identifiers.

## Validation Rules

### 1. Amount Validation (`payment.amount`)

Amounts are validated strictly to prevent overflow, precision loss, and malformed inputs.

- **Type**: Positive integer (minor units) or strict decimal string.
- **Constraints**:
  - Must be greater than 0.
  - Maximum value: 100,000,000,000,000 (100 trillion minor units).
  - Decimal strings: Max 7 decimal places (Stellar precision).
- **Error Code**: `INVALID_AMOUNT`
- **Examples**:
  - Valid: `1000`, `"10.50"`, `"0.0000001"`
  - Invalid: `-100`, `"abc"`, `"10.12345678"` (too many decimals), `0`

### 2. Asset Validation (`payment.asset`)

Stellar-related fields must follow strict Stellar conventions.

- **Type**: String
- **Format**: 
  - `native` for Stellar Lumens (XLM).
  - `AssetCode:Issuer` for other Stellar assets.
- **Constraints**:
  - `AssetCode`: 1-12 alphanumeric characters.
  - `Issuer`: 56 characters, starting with 'G' (Stellar public key format).
- **Requirement**: Required if `paymentMethod` is `crypto`.
- **Error Code**: `INVALID_ASSET`
- **Examples**:
  - Valid: `"native"`, `"USDC:G... (56 chars)"`
  - Invalid: `"USDC"`, `"native:G..."`, malformed issuer keys.

### 3. Currency Support (`payment.currency`)

- **Supported**: `USD`, `EUR`, `GBP`, `XLM`
- **Error Code**: `INVALID_CURRENCY`

### 4. Email Validation (`customer.email`)

- **Format**: RFC 5321 compliant.
- **Max Length**: 254 characters.
- **Error Code**: `INVALID_EMAIL`

### 5. Customer ID (`customer.customerId`)

- **Format**: Alphanumeric, hyphens, and underscores.
- **Length**: 1-255 characters.
- **Error Code**: `INVALID_CUSTOMER_ID`

## Security Assumptions

- **Early Rejection**: All malformed inputs are rejected by the middleware before reaching the service layer.
- **Precision**: Decimal strings are preferred for crypto amounts to avoid JavaScript floating-point precision issues.
- **Bounds**: Strict upper bounds prevent potential integer overflow in downstream systems.

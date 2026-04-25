# Audit Events Registry

This document serves as a registry for all application audit events, specifically focusing on checkout operations. This enables secure investigations and improves support without logging sensitive raw data.

## Checkout Service Events

The `CheckoutSessionService` emits the following structured audit events to track payment flows and outcomes safely.

### 1. `checkout.initiated`
- **Description**: Triggered immediately when a request to create a checkout session is received.
- **Resource**: `customer:<customerId>`
- **Metadata**:
  - `amount`: Transaction amount
  - `currency`: Transaction currency
  - `paymentMethod`: Requested payment method (e.g., `credit_card`)

### 2. `checkout.validated`
- **Description**: Emitted after verifying initial conditions like session storage limits and authorization parameters.
- **Resource**: `customer:<customerId>`
- **Status**: `"success"` or `"failed"`
- **Metadata**:
  - `reason`: Explanation if validation fails (e.g., "Authorization required")

### 3. `checkout.reserved`
- **Description**: Emitted once a checkout session is safely persisted in the memory/database store. Indicates the session is pending payment.
- **Resource**: `session:<sessionId>`
- **Metadata**:
  - `customerId`: Unique ID of the customer
  - `amount`: Payment amount
  - `currency`: Payment currency
  - `paymentMethod`: The method of payment chosen

### 4. `checkout.paid`
- **Description**: Emitted when a checkout session's payment step completes successfully.
- **Resource**: `session:<sessionId>`
- **Status**: `"success"` or `"failed"` (if transitioned from an invalid state)
- **Metadata**:
  - `customerId`: Unique ID of the customer
  - `amount`: Payment amount
  - `currency`: Payment currency
  - `paymentMethod`: The method of payment chosen
  - `tokenProvided`: Boolean indicating if a payment token was received (the actual token is deliberately redacted).
  - `reason`: Logged if status is `"failed"`.

### 5. `checkout.failed`
- **Description**: Emitted when an explicit failure request is triggered, marking the session payment as failed.
- **Resource**: `session:<sessionId>`
- **Status**: `"success"` or `"failed"` (if transitioned from an invalid state)
- **Metadata**:
  - `customerId`: Unique ID of the customer
  - `reason`: Failure reason, or "Unknown"

### 6. `checkout.cancelled`
- **Description**: Emitted when the user or system cancels the session explicitly.
- **Resource**: `session:<sessionId>`
- **Status**: `"success"` or `"failed"` (if transitioned from an invalid state)
- **Metadata**:
  - `customerId`: Unique ID of the customer
  - `reason`: Failure reason logged if state transition is invalid.

## Security Controls

All events must strictly adhere to the following data sanitization controls:
- **No Personally Identifiable Information (PII)**: Emails, first names, and last names must explicitly never appear in the `metadata` object.
- **No PCI Data**: Tokens (`paymentToken`), PANs, CVVs, or any sensitive processor data must be excluded or strictly mapped to a boolean abstraction (e.g., `tokenProvided: true`).

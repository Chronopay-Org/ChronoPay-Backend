# Payments / Checkout Core

This document outlines the architecture, flow, and logging aspects of the Checkout Service.

## Overview
The Checkout Service manages the session lifecycle of payments:
- Initiating payment intents
- Authorizing requests
- Tracking status across multiple steps
- Expiring stale session objects 

## State Machine
A checkout session follows these primary states:

1. **PENDING**: The default state once a transaction is successfully initialized.
2. **COMPLETED**: The user has successfully rendered payment, and a confirmation token has been registered.
3. **FAILED**: The payment was explicitly rejected by the client or the payment gateway.
4. **CANCELLED**: The user stopped the flow deliberately without supplying payment data.
5. **EXPIRED**: Built-in cron / time check automatically transitions pending orders over 24 hours to this state.

## Audit Interactions

To monitor checkout health, the `CheckoutSessionService` publishes audit events at key transitional steps:
- **checkout.initiated** - On start.
- **checkout.validated** - Validation passing or failing.
- **checkout.reserved** - Session stored successfully as PENDING.
- **checkout.paid** - Session transitioned to COMPLETED.
- **checkout.failed** - Session transitioned to FAILED.
- **checkout.cancelled** - Session transitioned to CANCELLED.

Through these events, debugging is achievable without violating data protection standards. We purposely scrub `paymentToken`, `email`, and `address` fields prior to logging them into the `AuditLogger`.

# ChronoPay Backend documentation index

Entry point: [../README.md](../README.md). Files below are existing design notes; they were written per-feature, so check the code when in doubt.

## API
- [api/slots.md](api/slots.md), [api/booking-intents.md](api/booking-intents.md), [booking-intent-api.md](booking-intent-api.md), [api/checkout.md](api/checkout.md), [payments/checkout.md](payments/checkout.md), [api/buyer-profile.md](api/buyer-profile.md)
- [api/errors.md](api/errors.md), [api/error-status-mapping.md](api/error-status-mapping.md), [error-codes.md](error-codes.md), [ERROR_TAXONOMY.md](ERROR_TAXONOMY.md), [contracts/errors.md](contracts/errors.md)
- [api/headers.md](api/headers.md), [api/content-negotiation.md](api/content-negotiation.md), [api/grace-window.md](api/grace-window.md), [api/pricing-strategies.md](api/pricing-strategies.md), [pricing-strategies.md](pricing-strategies.md)
- Root-level: [../CHECKOUT_API.md](../CHECKOUT_API.md), [../CHECKOUT_SECURITY.md](../CHECKOUT_SECURITY.md)

## Architecture and setup
- [architecture/backend.md](architecture/backend.md), [SETUP_GUIDE.md](SETUP_GUIDE.md), [environment-validation.md](environment-validation.md), [redis.md](redis.md), [caching.md](caching.md), [idempotency.md](idempotency.md)
- Database: [database/migrations.md](database/migrations.md), [database/geo-radius-search.md](database/geo-radius-search.md), [database/observability.md](database/observability.md), [MIGRATION_SAFETY_IMPLEMENTATION.md](MIGRATION_SAFETY_IMPLEMENTATION.md)

## Security and auth
- [API_SECURITY.md](API_SECURITY.md), [SECURITY_VALIDATION.md](SECURITY_VALIDATION.md), [CORS_CONFIGURATION.md](CORS_CONFIGURATION.md), [rate-limiting.md](rate-limiting.md)
- [auth/jwt.md](auth/jwt.md), [auth/mfa.md](auth/mfa.md), [auth/api-keys.md](auth/api-keys.md), [auth/permissions.md](auth/permissions.md), [auth/role-hierarchy.md](auth/role-hierarchy.md)
- [security/](security/) (headers, impersonation recording, internal auth, Redis encryption, request limits), [IMPERSONATION_EXAMPLES.md](IMPERSONATION_EXAMPLES.md), [SECRET_ROTATION_RUNBOOK.md](SECRET_ROTATION_RUNBOOK.md), [audit-events.md](audit-events.md), [dependency-scanning.md](dependency-scanning.md)

## Domain features
- Disputes: [dispute-appeals.md](dispute-appeals.md), [dispute-deadline.md](dispute-deadline.md)
- Cancellation/holds: [cancellation-overrides.md](cancellation-overrides.md), [prorated-cancellation-ledger.md](prorated-cancellation-ledger.md), [refundable-hold-escalation.md](refundable-hold-escalation.md), [refundable-hold-sweeper.md](refundable-hold-sweeper.md)
- Fraud: [fraud-detection.md](fraud-detection.md), [fraud-drift.md](fraud-drift.md), [fraud-model-registry.md](fraud-model-registry.md)
- Escrow/payouts: [escrow-event-listener.md](escrow-event-listener.md), [payout-quarantine.md](payout-quarantine.md), [runbook/escrow-migration.md](runbook/escrow-migration.md), [hsm-adapter.md](hsm-adapter.md)
- Feature flags: [feature-flags.md](feature-flags.md), [feature-flag-rollouts.md](feature-flag-rollouts.md)
- Privacy: [gdpr-erasure.md](gdpr-erasure.md), [pii-conformance.md](pii-conformance.md), [differential-privacy.md](differential-privacy.md), [note-sanitization.md](note-sanitization.md)
- Other: [reminders.md](reminders.md), [notifications/sms.md](notifications/sms.md), [capacity-simulator.md](capacity-simulator.md), [scheduler-job-runner-contract.md](scheduler-job-runner-contract.md), [payments/rounding.md](payments/rounding.md)

## Observability and reliability
- [observability.md](observability.md), [observability/pii.md](observability/pii.md), [LOGGING.md](LOGGING.md), [LOGGING_QUICK_REFERENCE.md](LOGGING_QUICK_REFERENCE.md), [metrics.md](metrics.md), [tracing.md](tracing.md), [OPENTELEMETRY_IMPLEMENTATION.md](OPENTELEMETRY_IMPLEMENTATION.md), [grafana-loki-quickstart.md](grafana-loki-quickstart.md), [wal-integrity.md](wal-integrity.md)
- [reliability/](reliability/) (dependency outages, expiry cleanup worker, timeouts)

## Testing
- [testing/contracts.md](testing/contracts.md), [testing/database.md](testing/database.md), [testing/redis.md](testing/redis.md), [ci-test-selection.md](ci-test-selection.md)

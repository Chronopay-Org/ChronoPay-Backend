# Webhook redelivery tracking

Webhook deliveries now maintain a lightweight per-endpoint redelivery tracker for settlement webhooks.

## Behavior

- Each endpoint/transaction pair keeps an attempt counter.
- A configurable maximum is enforced per endpoint.
- Once the maximum is exceeded, the delivery is marked as quarantined and the request returns a `429` response.
- The first successful processing result is retained so later duplicate deliveries return the same response.

## Configuration

The default maximum attempts is `3`, but it can be overridden with either:

- `WEBHOOK_REDELIVERY_MAX_ATTEMPTS`
- `redeliveryMaxAttempts` when registering webhook routes
- `redeliveryMaxAttemptsByEndpoint` for endpoint-specific overrides

## Metrics

The following Prometheus gauges are exposed:

- `webhook_redelivery_attempts{endpoint,status}`
- `webhook_redelivery_health{endpoint}`

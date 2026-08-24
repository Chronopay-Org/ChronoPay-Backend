# Anomaly scoring for booking-intents (issue #596)

Every booking-intent creation request receives an explainable anomaly score in
the range [0, 1]. Intents whose score exceeds the flag threshold are persisted
with their assessment and surfaced on an admin review queue so operators can
inspect likely-fraudulent bursts.

## Signals

The score combines four normalized signals with fixed weights:

| Signal            | Weight | Measures                                                                    |
| ----------------- | ------ | --------------------------------------------------------------------------- |
| `velocity`        | 0.35   | Intents the customer created inside a recent time window (burst behavior).   |
| `fingerprintRisk` | 0.20   | Unseen device fingerprint (mild) or a fingerprint shared across customers (strong sockpuppet signal). |
| `geoHopDistance`  | 0.30   | Great-circle distance between the customer's last observed location and the current one ("impossible travel" scores highest). |
| `buyerAge`        | 0.15   | Account age derived from account creation or earliest booking intent; accounts younger than a day score highest. |

Every signal is normalized to [0, 1] and defaults to **0 when its input is
missing** — absent evidence must never inflate risk.

## Flagging

An intent is flagged when `score > flagThreshold` (strictly greater; default
`0.7`). Flagged intents are:

- persisted on the intent record (`anomaly_score`, `anomaly_flagged`,
  `anomaly_signals` — see migration `021_add_anomaly_score_to_booking_intents`),
- enqueued on the in-memory anomaly review queue, exposed to admins at
  `GET /api/v1/admin/anomaly-queue`.

Both the deployed handler in `app.ts` and the modular router
(`createBookingIntentsRouter`) run the same shared helper
(`assessBookingIntentAnomaly`) so behavior stays identical across entrypoints.

## Environment configuration

| Variable                       | Default              | Meaning                                    |
| ------------------------------ | -------------------- | ------------------------------------------ |
| `ANOMALY_FLAG_THRESHOLD`       | `0.7`                | Score above which an intent is flagged.    |
| `ANOMALY_VELOCITY_WINDOW_MS`   | `300000` (5 minutes) | Window for counting recent intents per customer. |
| `ANOMALY_VELOCITY_BURST_COUNT` | `4`                  | Intent count inside the window that saturates the velocity signal. |

## Privacy

- Raw device fingerprints are never persisted — only a SHA-256 hash is kept,
  mirroring `fraudScorer.ts`.
- The default IP→location resolver maps IPs to deterministic
  pseudo-coordinates so same-network comparisons remain consistent without
  shipping a GeoIP database. Production deployments should inject a real GeoIP
  resolver via the scorer's `resolveLocation` option.

## State retention

Fingerprint/location indexes are per-process and bounded (10k customers /
20k fingerprints with FIFO eviction); the review queue is capped at 1000
items. Velocity and buyer-age signals are derived from persisted intent
history (`listByCustomer`), so they survive restarts.

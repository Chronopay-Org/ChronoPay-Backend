# Fraud detection notes

The fraud scorer now performs lightweight co-occurrence checks for suspicious behavior patterns.

## What is detected
- Shared IP address across different actors within the in-memory tracker.
- Shared device fingerprint across different actors, stored only as a SHA-256 hash.
- A review case is created when both signals appear together for the same request pattern.

## Privacy considerations
- Raw device fingerprints are never persisted.
- Only a one-way SHA-256 hash is used for comparison and case evidence.

## Scoring
- Each trigger adds to the fraud score.
- Shared IP and shared fingerprint reasons contribute to the score, and a sockpuppet review case is emitted when both are present.

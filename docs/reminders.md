# Reminder Scheduling: Timezone Strategy

## Overview

All reminder times are stored and processed in **UTC**. When a caller supplies
a timezone identifier it is validated and resolved for contextual use, but the
internal schedule is always UTC-based, which eliminates DST-related off-by-one
errors at trigger time.

## Default timezone

When no timezone is provided, the system defaults to `UTC`.

## Input fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `slotId` | positive integer | yes | The slot to attach reminders to |
| `startTime` | integer (epoch ms) | yes | UTC epoch milliseconds for the slot start |
| `timezone` | string (IANA) | no | Caller's intended timezone; validated but does not alter UTC storage |

## Timezone validation

Timezones are validated using the platform `Intl.DateTimeFormat` API — no
third-party library is required. Only IANA timezone database identifiers are
accepted.

### Accepted examples

```
UTC
America/New_York
Europe/London
Asia/Tokyo
Australia/Sydney
Pacific/Auckland
```

### Rejected inputs

- Empty or whitespace-only strings
- Unrecognised identifiers (e.g. `Fake/Zone`, `America/NotACity`)
- Any non-string value

> **Note on abbreviations:** Three-letter abbreviations such as `PST` or `CST`
> are not reliably unique across regions and their support varies by platform.
> Always use canonical IANA identifiers.

## Scheduling constraints

API callers should run `validateReminderScheduleInput` before calling the
service layer. It enforces the following:

| Constraint | Value | Reason |
|-----------|-------|--------|
| Minimum lead time | 60 seconds | Prevents reminders that would fire almost immediately |
| Maximum look-ahead | 365 days | Guards against unit-mismatch bugs (seconds vs milliseconds) |

## DST handling

Because `startTime` is a UTC epoch millisecond value, DST transitions have no
effect on trigger accuracy — there is no wall-clock ambiguity in UTC.

### Why UTC-first avoids DST bugs

Wall-clock times in DST-observing timezones can be:

- **Ambiguous** (fall-back): e.g. 1:30 AM Eastern exists twice on the first
  Sunday of November. A wall-clock time alone cannot distinguish the two.
- **Non-existent** (spring-forward): e.g. 2:30 AM Eastern does not exist on
  the second Sunday of March. Scheduling against it would silently drift.

By accepting `startTime` as UTC epoch milliseconds neither ambiguity arises,
regardless of the caller's local clock.

### DST transition detection

The `isInDSTTransition` utility returns `true` when a UTC instant falls within
the clock-change window of a given IANA timezone. Use it to warn callers whose
requested time is near a DST boundary:

```typescript
import {
  isInDSTTransition,
  isValidIANATimezone,
} from "../validation/reminderValidation.js";

const userTimezone = "America/New_York";
const slotStart = 1730620800000; // Nov 3 2024 06:00 UTC — fall-back hour

if (isValidIANATimezone(userTimezone) && isInDSTTransition(slotStart, userTimezone)) {
  // Optionally warn the caller that the local time is ambiguous
}
```

## Full validation flow (API route example)

```typescript
import { validateReminderScheduleInput } from "../validation/reminderValidation.js";
import { scheduleReminders } from "../services/reminderService.js";

// In your route handler:
const { slotId, startTime, timezone } = req.body;
const check = validateReminderScheduleInput(slotId, startTime, timezone);

if (!check.valid) {
  return res.status(400).json({ success: false, errors: check.errors });
}

// check.resolvedTimezone is "UTC" if none was provided
scheduleReminders(check.normalizedStartTime!, check.normalizedStartTime!, check.resolvedTimezone);
```

## Security notes

- Validation error messages reference field names and constraint descriptions
  only — raw user-supplied values are **never** echoed in responses.
- Invalid input is rejected entirely before any store interaction occurs.
- Whitespace-only timezone strings are rejected the same as empty strings.

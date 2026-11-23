# Slot Time Validation Implementation

## Changes Made

### 1. src/routes/slots.ts (POST /api/v1/slots handler)

**Problem:** The original code coerced unparseable times to 0 when `Date.parse()` returned NaN, silently creating slots with bogus ranges.

**Solution:** Implemented strict validation:
- Reject unparseable `startTime` with HTTP 422 and clear error message
- Reject unparseable `endTime` with HTTP 422 and clear error message
- Normalize all accepted values to epoch milliseconds before calling `slotService.createSlot`
- Added max duration guard (24 hours) to prevent unreasonably long slots
- Returns HTTP 422 for duration exceeding 24 hours

**Key changes (lines 182-214):**
```typescript
// Parse and validate time values
const start = typeof startTime === "number" ? startTime : Date.parse(startTime);
const end = typeof endTime === "number" ? endTime : Date.parse(endTime);

// Reject unparseable times with 422
if (isNaN(start)) {
  res.status(422).json({ success: false, error: "startTime must be a valid numeric epoch or ISO-8601 date-time string" });
  return;
}
if (isNaN(end)) {
  res.status(422).json({ success: false, error: "endTime must be a valid numeric epoch or ISO-8601 date-time string" });
  return;
}

// Validate time range
if (start >= end) {
  res.status(400).json({ success: false, error: "endTime must be greater than startTime" });
  return;
}

// Add max duration guard (24 hours in milliseconds)
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
if (end - start > MAX_DURATION_MS) {
  res.status(422).json({ success: false, error: "Slot duration cannot exceed 24 hours" });
  return;
}

// Pass normalized epoch milliseconds to service
const created = slotService.createSlot({
  professional,
  startTime: start,
  endTime: end,
});
```

### 2. src/__tests__/slots.validation.test.ts (New test file)

Created comprehensive test suite covering all edge cases:

**Valid inputs:**
- Valid numeric epoch milliseconds
- Valid ISO-8601 date-time strings
- ISO-8601 with timezone offset
- Valid epoch within max duration (24 hours)

**Invalid time formats (422 errors):**
- Garbage string for startTime
- Garbage string for endTime
- Both garbage strings
- Empty string for startTime
- Null for startTime
- Undefined for startTime (caught by required field validation)

**Invalid time ranges (400/422 errors):**
- End time equal to start time (400)
- End time before start time (400)
- Very large duration (> 24 hours) (422)
- Extremely large duration (422)
- Exactly 24 hours duration (accepted)

**Mixed valid/invalid formats:**
- Numeric startTime and ISO-8601 endTime
- ISO-8601 startTime and numeric endTime
- Numeric startTime with garbage endTime

**Edge cases with special values:**
- Infinity for startTime
- NaN for startTime (as number)
- Zero epoch with invalid range
- Zero epoch with valid range

**ISO-8601 format variations:**
- ISO-8601 date only
- Malformed ISO-8601

## Testing Instructions

To run the tests, you need Node.js installed. Once installed:

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage
```

## Next Steps

1. Install Node.js if not already installed
2. Run `npm install` to install dependencies
3. Run `npm test` to execute the test suite
4. Verify test coverage meets 95% requirement
5. Create the feature branch:
   ```bash
   git checkout -b feat/slot-time-validation
   ```
6. Commit changes:
   ```bash
   git add src/routes/slots.ts src/__tests__/slots.validation.test.ts
   git commit -m "feat: strict time validation on slot creation"
   ```
7. Push to your fork:
   ```bash
   git push origin feat/slot-time-validation
   ```

## Security Considerations

- **No fallback to 0:** The implementation explicitly rejects unparseable times instead of silently coercing to epoch 0
- **Clear error messages:** Returns specific error messages indicating what format is expected
- **Appropriate HTTP status codes:** Uses 422 for validation errors (unprocessable entity) and 400 for logical errors
- **Duration limits:** Prevents creation of unreasonably long slots that could impact system resources
- **Input normalization:** All accepted values are normalized to epoch milliseconds before storage, ensuring consistency

## Edge Cases Covered

✓ Garbage string time
✓ Negative epoch (accepted as valid numeric)
✓ End equals start (rejected)
✓ Very large range (> 24 hours, rejected)
✓ Valid numeric epochs
✓ Valid ISO-8601 strings
✓ Mixed formats
✓ Special values (Infinity, NaN, null, empty string)
✓ ISO-8601 variations

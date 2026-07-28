// rrule is a CJS module; import the default export and destructure for
// compatibility with Jest's --experimental-vm-modules ESM test environment.
import type { RRule as RRuleType } from "rrule";
import rruleLib from "rrule";
const { RRule, rrulestr } = rruleLib as any as {
  RRule: typeof RRuleType;
  rrulestr: (rruleStr: string, options?: Record<string, unknown>) => RRuleType;
};

export const MAX_OCCURRENCES = 200;

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

export function expandRRule(rruleText: string, dtstartIso?: string): Date[] {
  if (typeof rruleText !== "string" || rruleText.trim().length === 0) {
    throw new RecurrenceError("rrule must be a non-empty string");
  }

  // rrulestr accepts DTSTART inline or we can supply it via options
  let rule: RRuleType;
  try {
    rule = rrulestr(rruleText, { forceset: false }) as unknown as RRuleType;
  } catch (_err) {
    throw new RecurrenceError("Invalid RRULE format");
  }

  // Ensure RRULE is bounded (COUNT or UNTIL)
  const options = rule.options;
  if ((options.count ?? 0) <= 0 && !options.until) {
    throw new RecurrenceError("Unbounded RRULE is not allowed; include COUNT or UNTIL");
  }

  // Limit occurrences to a safe maximum
  const occurrences: Date[] = rule.all((_occurrence: Date, i: number) => i < MAX_OCCURRENCES + 1);
  if (occurrences.length > MAX_OCCURRENCES) {
    throw new RecurrenceError(`RRULE expands to more than ${MAX_OCCURRENCES} occurrences`);
  }

  return occurrences;
}

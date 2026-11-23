/**
 * conflictPreviewService.ts
 *
 * Pre-save conflict detection for RRULE series. Expands a proposed recurrence
 * rule, computes each occurrence's [start, end) window, and checks every
 * occurrence against existing slots for the same professional.
 *
 * Returns a categorized conflict list with suggested next-safe start times so
 * suppliers can review all collisions before confirming a series.
 *
 * Security notes:
 *  - Read-only operation — no writes to any store.
 *  - Input validation is delegated to the Zod schema on the route; this service
 *    trusts that `rrule` has already been syntax-checked.
 *  - The RRULE expansion is bounded by MAX_OCCURRENCES (200) and horizonDays
 *    (max 365) to prevent resource exhaustion.
 */

import { type SlotRepository, InMemorySlotRepository } from "../modules/slots/slot-repository.js";
import { expandRRule } from "./recurrenceService.js";
import { isInDSTTransition } from "../validation/reminderValidation.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default materialization horizon in days (matches scheduler). */
export const DEFAULT_HORIZON_DAYS = 90;

/** Maximum allowed horizon to prevent unbounded expansion. */
export const MAX_HORIZON_DAYS = 365;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConflictCategory = "overlap" | "blackout" | "tz-ambiguity";

export interface ConflictPreviewRequest {
  rrule: string;
  professional: string;
  slotDurationMs: number;
  timezone?: string;
  horizonDays?: number;
}

export interface ConflictSlotRef {
  slotId: string;
  slotStart: number;
  slotEnd: number;
}

export interface ConflictItem {
  proposedStart: number;
  proposedEnd: number;
  conflict: ConflictSlotRef;
  reason: ConflictCategory;
  detail: string;
  suggestedNextSafeStart?: number;
}

export interface ConflictPreviewResult {
  totalOccurrences: number;
  conflictsFound: number;
  conflicts: ConflictItem[];
  horizonDays: number;
  horizonEnd: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ConflictPreviewService {
  private readonly repo: SlotRepository;

  constructor(repo?: SlotRepository) {
    this.repo = repo ?? new InMemorySlotRepository();
  }

  /**
   * Preview all conflicts between a proposed RRULE series and existing slots.
   *
   * Steps:
   *  1. Expand the RRULE into concrete dates.
   *  2. Filter to the materialization horizon [now, now + horizonDays].
   *  3. For each occurrence, compute [start, end) and check for overlaps.
   *  4. Categorize each conflict and suggest next-safe start times.
   */
  async previewConflicts(req: ConflictPreviewRequest): Promise<ConflictPreviewResult> {
    const now = Date.now();
    const horizonDays = req.horizonDays ?? DEFAULT_HORIZON_DAYS;
    const horizonEnd = now + horizonDays * 24 * 60 * 60 * 1000;

    const occurrences = expandRRule(req.rrule);
    const horizonOccurrences = occurrences.filter(
      (d) => d.getTime() >= now && d.getTime() <= horizonEnd,
    );

    const allSlots = this.repo.list();
    const profSlots = allSlots
      .filter((s) => s.professional === req.professional)
      .sort((a, b) => a.startTime - b.startTime);

    const conflicts: ConflictItem[] = [];

    for (const occ of occurrences) {
      const occStart = occ.getTime();
      const occEnd = occStart + req.slotDurationMs;

      if (occStart < now || occStart > horizonEnd) {
        continue;
      }

      for (const slot of profSlots) {
        if (slot.startTime < occEnd && slot.endTime > occStart) {
          const reason = this.categorizeConflict(occStart, occEnd, slot.startTime, slot.endTime, req.timezone);
          const detail = this.buildDetail(reason, slot.id, slot.startTime, slot.endTime);
          const suggestedNextSafeStart = this.findNextSafeStart(
            req.professional,
            slot.endTime,
            req.slotDurationMs,
            profSlots,
          );

          conflicts.push({
            proposedStart: occStart,
            proposedEnd: occEnd,
            conflict: {
              slotId: slot.id,
              slotStart: slot.startTime,
              slotEnd: slot.endTime,
            },
            reason,
            detail,
            suggestedNextSafeStart,
          });
        }
      }
    }

    return {
      totalOccurrences: horizonOccurrences.length,
      conflictsFound: conflicts.length,
      conflicts,
      horizonDays,
      horizonEnd,
    };
  }

  /**
   * Determine the conflict category for an overlapping occurrence.
   *
   * Categories:
   *  - "overlap"       — standard time-range overlap with an existing slot
   *  - "blackout"      — reserved for future blackout period support
   *  - "tz-ambiguity"  — occurrence falls on a DST transition boundary
   */
  categorizeConflict(
    proposedStart: number,
    _proposedEnd: number,
    _slotStart: number,
    _slotEnd: number,
    timezone?: string,
  ): ConflictCategory {
    if (timezone && isInDSTTransition(proposedStart, timezone)) {
      return "tz-ambiguity";
    }
    return "overlap";
  }

  /**
   * Find the next available start time after a conflicting slot ends,
   * ensuring no overlap with any existing slot.
   *
   * Returns undefined when no gap large enough for `durationMs` exists
   * within a reasonable search window (100 consecutive slots).
   */
  findNextSafeStart(
    professional: string,
    afterMs: number,
    durationMs: number,
    profSlots?: Array<{ startTime: number; endTime: number }>,
  ): number | undefined {
    const slots = profSlots ?? this.repo.list().filter((s) => s.professional === professional);
    const sorted = [...slots].sort((a, b) => a.startTime - b.startTime);

    let candidate = afterMs;
    const maxIterations = 100;

    for (let i = 0; i < maxIterations; i++) {
      const candidateEnd = candidate + durationMs;
      let conflicts = false;

      for (const slot of sorted) {
        if (slot.startTime < candidateEnd && slot.endTime > candidate) {
          candidate = slot.endTime;
          conflicts = true;
          break;
        }
      }

      if (!conflicts) {
        return candidate;
      }
    }

    return undefined;
  }

  /**
   * Build a human-readable detail string for a conflict.
   */
  private buildDetail(
    reason: ConflictCategory,
    slotId: string,
    slotStart: number,
    slotEnd: number,
  ): string {
    switch (reason) {
      case "tz-ambiguity":
        return `Timezone ambiguity near DST transition; overlaps slot ${slotId} [${slotStart}, ${slotEnd})`;
      case "blackout":
        return `Blackout period; overlaps slot ${slotId} [${slotStart}, ${slotEnd})`;
      case "overlap":
      default:
        return `Overlaps existing slot ${slotId} [${slotStart}, ${slotEnd})`;
    }
  }
}

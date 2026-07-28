/**
 * LTR Event Emitter
 *
 * Emits search impression and click events for offline LTR training.
 *
 * Design:
 *   - Fire-and-forget: emission is synchronous and cheap (just writes to logger).
 *   - Events are structured JSON logged via pino at info level.
 *   - An offline pipeline (e.g., Spark / Beam) picks these up from log aggregation.
 *   - No external I/O on the hot path — safe for < 5 ms budget constraint.
 *
 * Security:
 *   - userId is expected to be pseudonymized / hashed before emission.
 *   - No raw PII is logged.
 */

import { logger } from "../../utils/logger.js";
import type {
  LtrEventEmitter,
  SearchClickEvent,
  SearchImpressionEvent,
} from "./types.js";

/**
 * Concrete implementation of LtrEventEmitter.
 *
 * Events are logged as structured pino info-level messages with a reserved
 * `ltr_event` marker field so the offline pipeline can filter them.
 */
export class SearchLtrEventEmitter implements LtrEventEmitter {
  /**
   * Emit a search impression event.
   * Logged as a structured pino info-level message.
   */
  public emitImpression(event: SearchImpressionEvent): void {
    logger.info(
      {
        ltr_event: "search_impression",
        searchId: event.searchId,
        userId: event.userId,
        query: event.query,
        displayedCount: event.displayedSlots.length,
        displayedSlots: event.displayedSlots,
        timestamp: event.timestamp,
      },
      "LTR search impression emitted",
    );
  }

  /**
   * Emit a search click event.
   * Logged as a structured pino info-level message.
   */
  public emitClick(event: SearchClickEvent): void {
    logger.info(
      {
        ltr_event: "search_click",
        searchId: event.searchId,
        slotId: event.slotId,
        position: event.position,
        userId: event.userId,
        timestamp: event.timestamp,
      },
      "LTR search click emitted",
    );
  }
}

/**
 * No-op emitter for when LTR is disabled or in test environments.
 * Satisfies the LtrEventEmitter interface without producing side effects.
 */
export class NoopLtrEventEmitter implements LtrEventEmitter {
  public emitImpression(_event: SearchImpressionEvent): void {
    // no-op
  }

  public emitClick(_event: SearchClickEvent): void {
    // no-op
  }
}

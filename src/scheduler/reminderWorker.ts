import { type Reminder, type ReminderRepository } from "../models/reminder.js";
import { claimDelivery } from "./reminderDedup.js";
import { reminderMetrics } from "./reminderMetrics.js";
import { getReminderRepository } from "../repositories/reminderRepository.js";
import { ReminderAutoscaler } from "./reminderAutoscaler.js";
import { type ReminderAutoscaleConfig } from "./reminderConfig.js";
import { logger } from "../utils/logger.js";

const MAX_RETRIES = 3;

export interface ProcessRemindersOptions {
  repository?: ReminderRepository;
  now?: number;
  maxRetries?: number;
  deliverReminder?: (reminder: Reminder) => Promise<void> | void;
  claimDeliveryFn?: typeof claimDelivery;
}

async function defaultDeliverReminder(reminder: Reminder): Promise<void> {
  logger.info(`[reminder] delivering id=${reminder.id} slotId=${reminder.slotId}`);
}

/**
 * Process a batch of due reminders.
 *
 * Accepts either a pre-filtered list of reminders (used by the autoscaling
 * worker loop) or fetches due reminders from the repository directly.
 *
 * Each reminder is protected by a Redis SET NX dedup claim so that only one
 * worker delivers it even when concurrency is scaled up.
 */
export async function processReminders(
  options: ProcessRemindersOptions & { reminders?: Reminder[] } = {}
): Promise<void> {
  const repository = options.repository ?? getReminderRepository();
  const now = options.now ?? Date.now();
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const dueReminders = options.reminders ?? (await repository.getDueReminders(now));

  for (const reminder of dueReminders) {
    // ── Deduplication check ──────────────────────────────────────────────────
    const claimDeliveryFn = options.claimDeliveryFn ?? claimDelivery;
    const claimed = await claimDeliveryFn(reminder.id, reminder.triggerAt);
    if (!claimed) {
      logger.info(`[reminder] skipped duplicate id=${reminder.id} triggerAt=${reminder.triggerAt}`);
      reminderMetrics.increment("skipped");
      continue;
    }

    // ── Deliver ──────────────────────────────────────────────────────────────
    try {
      const deliverReminder = options.deliverReminder ?? defaultDeliverReminder;
      await deliverReminder(reminder);
      await repository.markSent(reminder.id, now);
      reminderMetrics.increment("delivered");
      logger.info(`[reminder] delivered id=${reminder.id}`);
    } catch (error) {
      const updated = await repository.recordAttempt(reminder.id, now);
      const attempts = updated?.attempts ?? reminder.attempts + 1;

      if (attempts >= maxRetries) {
        await repository.markFailed(reminder.id, now);
        reminderMetrics.increment("failed");
        logger.error(`[reminder] failed id=${reminder.id} attempts=${attempts}`);
      } else {
        logger.warn(`[reminder] retry scheduled id=${reminder.id} attempts=${attempts}`);
      }

      if (error instanceof Error) {
        logger.error(`[reminder] delivery error id=${reminder.id}: ${error.message}`);
      }
    }
  }
}

export interface RunReminderWorkerOptions {
  autoscalerConfig?: Partial<ReminderAutoscaleConfig>;
  /** Optional repository override for testing. */
  repository?: ReminderRepository;
  /** Optional deliver function override for testing. */
  deliverReminder?: (reminder: Reminder) => Promise<void> | void;
  /** Optional claim function override for testing. */
  claimDeliveryFn?: typeof claimDelivery;
  /** Idle back-off in ms (default 500). */
  idleBackoffMs?: number;
  /** Optional signal to stop the worker loop (for tests). */
  signal?: AbortSignal;
}

/**
 * Run the reminder worker with backlog-driven autoscaling.
 *
 * Each iteration:
 *  1. Fetches due reminders (the backlog).
 *  2. Asks the autoscaler for the desired concurrency based on backlog depth.
 *  3. Partitions the backlog into chunks and processes them in parallel.
 *  4. Backs off when idle to avoid a tight loop.
 *
 * The loop continues until the provided AbortSignal is aborted.
 */
export async function runReminderWorker(
  options: RunReminderWorkerOptions = {}
): Promise<void> {
  const {
    autoscalerConfig,
    repository = getReminderRepository(),
    deliverReminder,
    claimDeliveryFn,
    idleBackoffMs = 500,
    signal,
  } = options;

  const autoscaler = new ReminderAutoscaler(autoscalerConfig);

  while (true) {
    if (signal?.aborted) {
      return;
    }

    const now = Date.now();
    const due = await repository.getDueReminders(now);
    const backlog = due.length;

    const concurrency = autoscaler.update(backlog);
    reminderMetrics.setConcurrency(concurrency);

    // Partition due reminders according to concurrency
    const chunkSize = Math.max(1, Math.ceil(due.length / concurrency));
    const chunks: Reminder[][] = [];
    for (let i = 0; i < due.length; i += chunkSize) {
      chunks.push(due.slice(i, i + chunkSize));
    }

    // Process chunks in parallel
    await Promise.all(
      chunks.map((chunk) =>
        processReminders({
          repository,
          now,
          reminders: chunk,
          deliverReminder,
          claimDeliveryFn,
        })
      )
    );

    // Back-off when idle to avoid tight loop
    if (backlog === 0) {
      await new Promise((resolve) => setTimeout(resolve, idleBackoffMs));
    }
  }
}

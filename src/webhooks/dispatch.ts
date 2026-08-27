/**
 * Webbhook dispatch with at-least-once delivery and exponential backoff.
 *
 * Retries on 5xx, 429 (respecting Retry-After), and network errors.
 * Any 2xx response marks the delivery as succeeded.
 * After the maximum number of attempts, throws an error (caller may
 * move the webhook to a DLQ).
 */

export interface WebbhookDispatchOptions {
  /** Target URL */
  url: string;
  /** Payload to POST as JSON */
  payload: unknown;
  /** Optional additional headers */
  headers?: Record<string, string>;
  /** Maximum delivery attempts (default 6) */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms (default 1000) */
  baseDelayMs?: number;
  /** Maximum backoff delay in ms (default 32000) */
  maxDelayMs?: number;
  /** Fetch implementation (default global fetch) */
  fetch?: typeof fetch;
  /** Sleep implementation for tests (default setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each attempt with the attempt number and result. */
  onAttempt?: (attempt: number, result: 'succeeded' | 'retry' | 'failed') => unknown;
}

/**
 * Dispatches a webhook with retry logic and exponential backoff.
 *
 * @param options - Dispatch configuration and payload.
 * @returns Response from the successful delivery (any 2xx).
 * @throws Error if delivery fails after all attempts or on a non-retryable status.
 */
export async function dispatchWebhook(options: WebhookDispatchOptions): Promise<Response> {
  const {
    url,
    payload,
    headers,
    maxAttempts = 6,
    baseDelayMs = 1000,
    maxDelayMs = 32000,
    fetch: fetchFn = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onAttempt = () => {},
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response | null = null;
    let requestError: unknown;

    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      requestError = err;
    }

    if (requestError !== undefined) {
      // Network error: treat as retryable unless we've exhausted attempts.
      if (attempt === maxAttempts) {
        onAttempt(attempt, 'failed');
        throw requestError;
      }
      onAttempt(attempt, 'retry');
      await sleep(computeBackoffDelay(attempt, baseDelayMs, maxDelayMs));
      continue;
    }

    const status = response!.status;

    if (status >= 200 && status < 300) {
      onAttempt(attempt, 'succeeded');
      return response!;
    }

    const retryable = status === 429 || status >= 500;
    if (!retryable) {
      const error = new Error(`Webhook delivery failed with status ${status}`);
      onAttempt(attempt, 'failed');
      throw error;
    }

    if (attempt === maxAttempts) {
      const error = new Error(
        `Webhook delivery failed after ${maxAttempts} attempts. Last status: ${status}`
      );
      onAttempt(attempt, 'failed');
      throw error;
    }

    onAttempt(attempt, 'retry');
    const retryAfterMs = parseRetryAfter(response!.headers.get('retry-after'));
    const delay = retryAfterMs !== undefined
      ? Math.min(retryAfterMs, maxDelayMs)
      : computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
    await sleep(delay);
  }

  // Unreachable for TypeScript, but required for a return type.
  throw new Error('Unexpected end of dispatch loop');
}

/**
 * Computes the exponential backoff delay based on the failed attempt number.
 * The first retry delay is baseDelayMs, the second is as\x2020, and so on.
 */
function computeBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Parses the Retry-After header into milliseconds.
 * Supports both a number of seconds and an HTTP-date string.
 * Returns undefined if parsing fails.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return undefined;
}

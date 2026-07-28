/**
 * slo-weekly-report.ts
 *
 * Computes weekly SLO error-budget consumption per service and posts a
 * concise Slack report with a per-service leaderboard.
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
 *   PROMETHEUS_URL=http://localhost:9090 \
 *   BURN_RATE_DASHBOARD_URL=https://grafana.example.com/d/... \
 *   npx tsx scripts/slo-weekly-report.ts
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SloData {
  /** Route or service name, e.g. "/api/v1/checkout" */
  route: string;
  /** Total number of requests in the window */
  totalRequests: number;
  /** Total number of bad events (errors, latency SLO misses, etc.) */
  badEvents: number;
  /** SLO target as a fraction, e.g. 0.99 for 99% */
  sloTarget: number;
  /** Error budget remaining as a fraction of the total budget (0..1) */
  remainingBudget: number;
}

export interface SlackMessage {
  text: string;
  blocks: any[];
}

export interface ReportOptions {
  prometheusUrl: string;
  slackWebhookUrl: string;
  burnRateDashboardUrl: string;
  /** How many days to look back (default 7) */
  windowDays?: number;
  /** Minimum remaining budget to flag as "at risk" */
  warningThreshold?: number;
  /** Minimum remaining budget to flag as "critical" */
  criticalThreshold?: number;
}

// ─── Prometheus Queries ──────────────────────────────────────────────────────

/**
 * Executes a Prometheus instant query and returns the result vector.
 */
export async function queryPrometheus(
  prometheusUrl: string,
  query: string,
): Promise<any[]> {
  const url = `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Prometheus query failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.status !== "success") {
    throw new Error(`Prometheus returned error: ${data.error || "unknown"}`);
  }

  return data.data.result;
}

/**
 * Fetches the remaining error budget fraction for each SLO/service.
 * Assumes the metric `slo_error_budget_remaining{route="...", slo="..."}` exists.
 * Returns values in range [0, 1] where 1 = full budget remaining.
 */
export async function fetchSloRemainingBudgets(
  prometheusUrl: string,
): Promise<SloData[]> {
  const results = await queryPrometheus(
    prometheusUrl,
    `slo_error_budget_remaining`,
  );

  return results.map((result: any) => {
    const route = result.metric.route || result.metric.service || "unknown";
    const remaining = parseFloat(result.value[1]);
    return {
      route,
      totalRequests: 0, // populated from separate query
      badEvents: 0,
      sloTarget: parseFloat(result.metric.slo || "0.99"),
      remainingBudget: isNaN(remaining) ? 1 : Math.max(0, Math.min(1, remaining)),
    };
  });
}

/**
 * Fetches total requests and bad events per route over the given window.
 * Assumes metrics `slo_requests_total{route="..."}` and
 * `slo_bad_events_total{route="..."}` exist with a counter total over the
 * last `windowDays` days.
 */
export async function fetchSloCounts(
  prometheusUrl: string,
  windowDays: number = 7,
): Promise<Map<string, { totalRequests: number; badEvents: number }>> {
  const range = `${windowDays}d`;
  const map = new Map<string, { totalRequests: number; badEvents: number }>();

  // Fetch total requests
  const requestsResult = await queryPrometheus(
    prometheusUrl,
    `increase(slo_requests_total[${range}])`,
  );
  for (const result of requestsResult) {
    const route = result.metric.route || result.metric.service || "unknown";
    const val = parseFloat(result.value[1]);
    const existing = map.get(route) || { totalRequests: 0, badEvents: 0 };
    existing.totalRequests += isNaN(val) ? 0 : Math.round(val);
    map.set(route, existing);
  }

  // Fetch bad events
  const badResult = await queryPrometheus(
    prometheusUrl,
    `increase(slo_bad_events_total[${range}])`,
  );
  for (const result of badResult) {
    const route = result.metric.route || result.metric.service || "unknown";
    const val = parseFloat(result.value[1]);
    const existing = map.get(route) || { totalRequests: 0, badEvents: 0 };
    existing.badEvents += isNaN(val) ? 0 : Math.round(val);
    map.set(route, existing);
  }

  return map;
}

// ─── Report Construction ─────────────────────────────────────────────────────

/**
 * Builds a Slack message payload with a per-service leaderboard.
 */
export function buildSlackReport(
  slos: SloData[],
  burnRateDashboardUrl: string,
): SlackMessage {
  // Sort by remaining budget ascending (worst first)
  const sorted = [...slos].sort((a, b) => a.remainingBudget - b.remainingBudget);

  const lines: string[] = [];
  const blocks: any[] = [];

  // Header
  const headerText = `📊 *Weekly SLO Error-Budget Report*\nPeriod: Past 7 days`;
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: headerText },
  });

  blocks.push({ type: "divider" });

  if (sorted.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No SLO data available for this period." },
    });
  } else {
    // Build the leaderboard table
    const tableHeader = "`Service` · `Budget Remaining` · `Status`";
    lines.push(tableHeader);

    for (const slo of sorted) {
      const pct = (slo.remainingBudget * 100).toFixed(1);
      const bar = budgetBar(slo.remainingBudget);
      const status = budgetStatus(slo.remainingBudget);
      const line = `\`${slo.route}\` · ${bar} \`${pct}%\` · ${status}`;
      lines.push(line);
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });

    blocks.push({ type: "divider" });

    // Footer with dashboard link
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${burnRateDashboardUrl}|View Burn-Rate Dashboard> · Generated ${new Date().toISOString()}`,
        },
      ],
    });
  }

  return {
    text: `Weekly SLO Report: ${sorted.filter((s) => s.remainingBudget < 0.2).length} service(s) critically low on error budget`,
    blocks,
  };
}

/**
 * Returns a simple ASCII-style bar representation.
 */
export function budgetBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Returns an emoji status label based on remaining budget.
 */
export function budgetStatus(fraction: number): string {
  if (fraction <= 0) return "🔴 Exhausted";
  if (fraction < 0.2) return "🔴 Critical";
  if (fraction < 0.5) return "🟡 At Risk";
  return "🟢 Healthy";
}

// ─── Slack Delivery ──────────────────────────────────────────────────────────

/**
 * Posts a Slack message via webhook.
 */
export async function postToSlack(
  webhookUrl: string,
  message: SlackMessage,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook returned ${response.status}: ${body}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Fetches SLO data, builds a Slack report, and posts it.
 */
export async function runReport(options: ReportOptions): Promise<void> {
  const windowDays = options.windowDays ?? 7;
  const slos = await fetchSloRemainingBudgets(options.prometheusUrl);
  const counts = await fetchSloCounts(options.prometheusUrl, windowDays);

  // Merge counts into SLO data
  for (const slo of slos) {
    const count = counts.get(slo.route);
    if (count) {
      slo.totalRequests = count.totalRequests;
      slo.badEvents = count.badEvents;
    }
  }

  const message = buildSlackReport(slos, options.burnRateDashboardUrl);
  await postToSlack(options.slackWebhookUrl, message);

  console.log(`SLO weekly report posted to Slack. ${slos.length} SLO(s) tracked.`);
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("slo-weekly-report.ts")) {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  const prometheusUrl = process.env.PROMETHEUS_URL || "http://localhost:9090";
  const burnRateDashboardUrl =
    process.env.BURN_RATE_DASHBOARD_URL || "https://grafana.example.com/d/slo-burn-rate";

  if (!slackWebhookUrl) {
    console.error("SLACK_WEBHOOK_URL environment variable is required.");
    process.exit(1);
  }

  runReport({
    prometheusUrl,
    slackWebhookUrl,
    burnRateDashboardUrl,
  }).catch((err) => {
    console.error("SLO weekly report failed:", err);
    process.exit(1);
  });
}

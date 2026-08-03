/**
 * slo-weekly-report.ts
 *
 * Computes weekly SLO error-budget consumption per route and posts a concise
 * Slack report with a per-service leaderboard.
 *
 * Usage:
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/... \
 *   PROMETHEUS_URL=http://localhost:9090 \
 *   BURN_RATE_DASHBOARD_URL=https://grafana.example.com/d/slo-burn-rate \
 *   npx tsx scripts/slo-weekly-report.ts
 */

import { fileURLToPath } from "node:url";
import {
  RouteName,
  SLO_OBJECTIVES,
} from "../src/metrics/sloMetrics.js";
import { REPORTED_ROUTES } from "../src/simulator/sloHeadroomReporter.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteCountInput {
  route: RouteName;
  totalRequests: number;
  badEvents: number;
  sloObjective?: number;
}

export interface SloData {
  route: RouteName;
  totalRequests: number;
  badEvents: number;
  sloObjective: number;
  /** Observed error rate over the window (0 when no traffic). */
  observedErrorRate: number;
  /** Fraction of the error budget consumed this week (0..∞). */
  consumedFraction: number;
  /** Remaining error budget as a fraction of the total budget (0..1). */
  remainingBudget: number;
  /** True when no requests were observed in the window. */
  noTraffic: boolean;
}

export interface SlackMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export interface ReportOptions {
  prometheusUrl?: string;
  slackWebhookUrl: string;
  burnRateDashboardUrl: string;
  windowDays?: number;
  /** Injectable fetch for tests and custom runtimes. */
  fetchFn?: typeof fetch;
}

type FetchFn = typeof fetch;

// ─── Budget math (aligned with sloHeadroomReporter) ─────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute weekly error-budget consumption for a single route.
 *
 *   errorBudget      = 1 − sloObjective
 *   consumedFraction = observedErrorRate / errorBudget
 *   remainingBudget  = clamp(1 − consumedFraction, 0, 1)
 */
export function computeRouteBudget(
  route: RouteName,
  totalRequests: number,
  badEvents: number,
  sloObjective: number = SLO_OBJECTIVES[route],
): SloData {
  const observedErrorRate =
    totalRequests > 0 ? badEvents / totalRequests : 0;
  const errorBudget = 1 - sloObjective;
  const noTraffic = totalRequests === 0;

  let consumedFraction = 0;
  if (!noTraffic && errorBudget > 0) {
    consumedFraction = observedErrorRate / errorBudget;
  } else if (!noTraffic && errorBudget === 0 && observedErrorRate > 0) {
    consumedFraction = Infinity;
  }

  const remainingBudget =
    noTraffic || !isFinite(consumedFraction)
      ? noTraffic
        ? 1
        : 0
      : clamp(1 - consumedFraction, 0, 1);

  return {
    route,
    totalRequests,
    badEvents,
    sloObjective,
    observedErrorRate,
    consumedFraction: noTraffic ? 0 : consumedFraction,
    remainingBudget,
    noTraffic,
  };
}

/**
 * Pure compute path used by tests and as a fallback when Prometheus is empty.
 */
export function computeWeeklyBudgets(routes: RouteCountInput[]): SloData[] {
  const byRoute = new Map<RouteName, RouteCountInput>();
  for (const entry of routes) {
    byRoute.set(entry.route, entry);
  }

  return REPORTED_ROUTES.map((route) => {
    const entry = byRoute.get(route);
    return computeRouteBudget(
      route,
      entry?.totalRequests ?? 0,
      entry?.badEvents ?? 0,
      entry?.sloObjective ?? SLO_OBJECTIVES[route],
    );
  });
}

export function defaultWeeklyBudgets(): SloData[] {
  return computeWeeklyBudgets([]);
}

// ─── Prometheus ─────────────────────────────────────────────────────────────

export async function queryPrometheus(
  prometheusUrl: string,
  query: string,
  fetchFn: FetchFn = fetch,
): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
  const url = `${prometheusUrl.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetchFn(url);

  if (!response.ok) {
    throw new Error(
      `Prometheus query failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    status: string;
    error?: string;
    data?: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
  };

  if (data.status !== "success") {
    throw new Error(`Prometheus returned error: ${data.error || "unknown"}`);
  }

  return data.data?.result ?? [];
}

function parseRouteLabel(metric: Record<string, string>): RouteName | null {
  const raw = metric.route || metric.service;
  if (raw && raw in SLO_OBJECTIVES) {
    return raw as RouteName;
  }
  return null;
}

async function fetchCounterCounts(
  prometheusUrl: string,
  windowDays: number,
  fetchFn: FetchFn,
): Promise<Map<RouteName, { totalRequests: number; badEvents: number }>> {
  const range = `${windowDays}d`;
  const map = new Map<RouteName, { totalRequests: number; badEvents: number }>();

  const requestQueries = [
    `increase(slo_requests_total[${range}])`,
    `increase(slo_route_requests_total[${range}])`,
  ];
  const errorQueries = [
    `increase(slo_bad_events_total[${range}])`,
    `increase(slo_route_errors_total[${range}])`,
  ];

  for (const query of requestQueries) {
    const results = await queryPrometheus(prometheusUrl, query, fetchFn);
    for (const result of results) {
      const route = parseRouteLabel(result.metric);
      if (!route) continue;
      const val = parseFloat(result.value[1]);
      const existing = map.get(route) ?? { totalRequests: 0, badEvents: 0 };
      existing.totalRequests += Number.isNaN(val) ? 0 : Math.round(val);
      map.set(route, existing);
    }
    if (map.size > 0) break;
  }

  for (const query of errorQueries) {
    const results = await queryPrometheus(prometheusUrl, query, fetchFn);
    for (const result of results) {
      const route = parseRouteLabel(result.metric);
      if (!route) continue;
      const val = parseFloat(result.value[1]);
      const existing = map.get(route) ?? { totalRequests: 0, badEvents: 0 };
      existing.badEvents += Number.isNaN(val) ? 0 : Math.round(val);
      map.set(route, existing);
    }
    if ([...map.values()].some((v) => v.badEvents > 0)) break;
  }

  return map;
}

async function fetchBurnRateBudgets(
  prometheusUrl: string,
  windowDays: number,
  fetchFn: FetchFn,
): Promise<Map<RouteName, number>> {
  const range = `${windowDays}d`;
  const query = `max by (route) (max_over_time(slo_burn_rate[${range}]))`;
  const results = await queryPrometheus(prometheusUrl, query, fetchFn);
  const map = new Map<RouteName, number>();

  for (const result of results) {
    const route = parseRouteLabel(result.metric);
    if (!route) continue;
    const burnRate = parseFloat(result.value[1]);
    if (Number.isNaN(burnRate)) continue;
    map.set(route, burnRate);
  }

  return map;
}

/**
 * Fetch weekly SLO data from Prometheus when configured, otherwise return
 * known routes at 100% remaining with a no-traffic marker.
 */
export async function fetchWeeklySloData(
  prometheusUrl: string | undefined,
  windowDays: number = 7,
  fetchFn: FetchFn = fetch,
): Promise<SloData[]> {
  if (!prometheusUrl?.trim()) {
    return defaultWeeklyBudgets();
  }

  try {
    const counts = await fetchCounterCounts(prometheusUrl, windowDays, fetchFn);
    if (counts.size > 0) {
      return computeWeeklyBudgets(
        REPORTED_ROUTES.map((route) => {
          const count = counts.get(route);
          return {
            route,
            totalRequests: count?.totalRequests ?? 0,
            badEvents: count?.badEvents ?? 0,
          };
        }),
      );
    }

    const burnRates = await fetchBurnRateBudgets(
      prometheusUrl,
      windowDays,
      fetchFn,
    );
    if (burnRates.size > 0) {
      return REPORTED_ROUTES.map((route) => {
        const consumedFraction = burnRates.get(route) ?? 0;
        const remainingBudget = clamp(1 - consumedFraction, 0, 1);
        return {
          route,
          totalRequests: 0,
          badEvents: 0,
          sloObjective: SLO_OBJECTIVES[route],
          observedErrorRate: 0,
          consumedFraction,
          remainingBudget,
          noTraffic: false,
        };
      });
    }
  } catch (err) {
    console.warn(
      "Prometheus unavailable or query failed; posting no-traffic defaults:",
      err instanceof Error ? err.message : err,
    );
  }

  return defaultWeeklyBudgets();
}

// ─── Report construction ────────────────────────────────────────────────────

export function formatPercent(fraction: number, digits = 1): string {
  if (!isFinite(fraction)) return "∞";
  return (fraction * 100).toFixed(digits);
}

export function budgetBar(fraction: number): string {
  const clamped = clamp(fraction, 0, 1);
  const filled = Math.round(clamped * 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function budgetStatus(remainingBudget: number): string {
  if (remainingBudget <= 0) return "🔴 Exhausted";
  if (remainingBudget < 0.2) return "🔴 Critical";
  if (remainingBudget < 0.5) return "🟡 At Risk";
  return "🟢 Healthy";
}

function formatRouteLine(slo: SloData): string {
  const remainingPct = formatPercent(slo.remainingBudget);
  const consumedPct = formatPercent(slo.consumedFraction);
  const bar = budgetBar(slo.remainingBudget);
  const status = budgetStatus(slo.remainingBudget);
  const trafficNote = slo.noTraffic ? " · _no traffic_" : "";
  return (
    `\`${slo.route}\` · ${bar} \`${remainingPct}%\` remaining · ` +
    `\`${consumedPct}%\` consumed · ${status}${trafficNote}`
  );
}

/**
 * Builds a Slack message payload with a per-service leaderboard (worst first).
 */
export function buildSlackReport(
  slos: SloData[],
  burnRateDashboardUrl: string,
  windowDays: number = 7,
): SlackMessage {
  const sorted = [...slos].sort((a, b) => a.remainingBudget - b.remainingBudget);
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `📊 *Weekly SLO Error-Budget Report*\nPeriod: past ${windowDays} days`,
    },
  });
  blocks.push({ type: "divider" });

  if (sorted.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "No SLO data available for this period.",
      },
    });
  } else {
    const lines = [
      "`Service` · `Remaining` · `Weekly consumption` · `Status`",
      ...sorted.map(formatRouteLine),
    ];

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
    blocks.push({ type: "divider" });
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

  const criticalCount = sorted.filter((s) => s.remainingBudget < 0.2).length;
  const exhaustedCount = sorted.filter((s) => s.remainingBudget <= 0).length;

  return {
    text:
      exhaustedCount > 0
        ? `Weekly SLO Report: ${exhaustedCount} route(s) exhausted error budget`
        : criticalCount > 0
          ? `Weekly SLO Report: ${criticalCount} route(s) critically low on error budget`
          : "Weekly SLO Report: all routes within error budget",
    blocks,
  };
}

// ─── Slack delivery ─────────────────────────────────────────────────────────

export async function postToSlack(
  webhookUrl: string,
  message: SlackMessage,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const response = await fetchFn(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook returned ${response.status}: ${body}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runReport(options: ReportOptions): Promise<SloData[]> {
  const windowDays = options.windowDays ?? 7;
  const fetchFn = options.fetchFn ?? fetch;

  const slos = await fetchWeeklySloData(
    options.prometheusUrl,
    windowDays,
    fetchFn,
  );
  const message = buildSlackReport(
    slos,
    options.burnRateDashboardUrl,
    windowDays,
  );
  await postToSlack(options.slackWebhookUrl, message, fetchFn);

  console.log(
    `SLO weekly report posted to Slack. ${slos.length} route(s) tracked.`,
  );
  return slos;
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  const prometheusUrl = process.env.PROMETHEUS_URL ?? "";
  const burnRateDashboardUrl =
    process.env.BURN_RATE_DASHBOARD_URL ??
    "https://grafana.example.com/d/slo-burn-rate";

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

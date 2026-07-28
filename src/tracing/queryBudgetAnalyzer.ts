import type { Span } from "./hooks.js";
import { addSpanExporter, removeSpanExporter } from "./spanExporter.js";

export interface QueryBudgetEntry {
  pattern: string;
  totalDuration: number;
  count: number;
  avgDuration: number;
  maxDuration: number;
  errorCount: number;
  errorRate: number;
  budgetShare: number;
}

export interface TopOffender {
  pattern: string;
  rank: number;
  avgDuration: number;
  maxDuration: number;
  count: number;
  errorRate: number;
  budgetShare: number;
}

interface PatternStats {
  totalDuration: number;
  count: number;
  maxDuration: number;
  errorCount: number;
}

const WINDOW_SIZE_MS = 5 * 60 * 1000;
const BUDGET_TARGET_MS = 1000;
const CLEANUP_INTERVAL_MS = 60_000;

const patternStats = new Map<string, PatternStats>();
let windowStart = Date.now();
let totalDuration = 0;
let isInstalled = false;

function derivePattern(span: Span): string {
  const route = span.attributes.route as string | undefined;
  if (route) return `${span.name} [${route}]`;
  if (span.name.startsWith("db.") || span.name.startsWith("redis.")) {
    return span.name;
  }
  return span.name;
}

function recordSpan(span: Span): void {
  if (!span.duration) return;

  const now = Date.now();
  if (now - windowStart > WINDOW_SIZE_MS) {
    patternStats.clear();
    totalDuration = 0;
    windowStart = now;
  }

  const pattern = derivePattern(span);
  const existing = patternStats.get(pattern) ?? {
    totalDuration: 0,
    count: 0,
    maxDuration: 0,
    errorCount: 0,
  };

  existing.totalDuration += span.duration;
  existing.count += 1;
  existing.maxDuration = Math.max(existing.maxDuration, span.duration);
  if (span.attributes.error) {
    existing.errorCount += 1;
  }

  totalDuration += span.duration;
  patternStats.set(pattern, existing);
}

function instalCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    if (now - windowStart > WINDOW_SIZE_MS) {
      patternStats.clear();
      totalDuration = 0;
      windowStart = now;
    }
  }, CLEANUP_INTERVAL_MS);
}

export function installQueryBudgetAnalyzer(): void {
  if (isInstalled) return;
  addSpanExporter(recordSpan);
  instalCleanup();
  isInstalled = true;
}

export function uninstallQueryBudgetAnalyzer(): void {
  if (!isInstalled) return;
  removeSpanExporter(recordSpan);
  patternStats.clear();
  totalDuration = 0;
  isInstalled = false;
}

export function getQueryBudgetReport(): {
  windowDurationMs: number;
  totalDurationMs: number;
  totalSpans: number;
  budgetUtilization: number;
  entries: QueryBudgetEntry[];
  topOffenders: TopOffender[];
} {
  const effectiveTotal = totalDuration || 1;
  const entries: QueryBudgetEntry[] = [];

  for (const [pattern, stats] of patternStats) {
    entries.push({
      pattern,
      totalDuration: stats.totalDuration,
      count: stats.count,
      avgDuration: Math.round(stats.totalDuration / stats.count),
      maxDuration: stats.maxDuration,
      errorCount: stats.errorCount,
      errorRate: stats.count > 0 ? stats.errorCount / stats.count : 0,
      budgetShare: stats.totalDuration / effectiveTotal,
    });
  }

  entries.sort((a, b) => b.totalDuration - a.totalDuration);

  const topOffenders: TopOffender[] = entries.slice(0, 20).map((entry, idx) => ({
    pattern: entry.pattern,
    rank: idx + 1,
    avgDuration: entry.avgDuration,
    maxDuration: entry.maxDuration,
    count: entry.count,
    errorRate: entry.errorRate,
    budgetShare: entry.budgetShare,
  }));

  return {
    windowDurationMs: WINDOW_SIZE_MS,
    totalDurationMs: totalDuration,
    totalSpans: entries.reduce((sum, e) => sum + e.count, 0),
    budgetUtilization: totalDuration / (BUDGET_TARGET_MS * WINDOW_SIZE_MS / 1000),
    entries,
    topOffenders,
  };
}

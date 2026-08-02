/**
 * SOC2 vendor inventory checker (issue #521).
 *
 * Validates `docs/security/vendors.yaml` against the documented schema,
 * enforces the 12-month review freshness rule, detects duplicate vendors and
 * currency changes that were not re-reviewed, and (in CI) posts a summary as
 * a PR comment.
 *
 * Exit codes:
 *  - 0: registry is valid and every entry is fresh
 *  - 1: validation or freshness errors (CI must fail)
 *
 * Usage:
 *   npx tsx scripts/vendor-inventory-check.ts [path-to-vendors.yaml]
 */

import { execSync } from "child_process";
import fs from "fs";
import https from "https";

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err && err.stack ? err.stack : err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err && err.stack ? err.stack : err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YamlValue = string | number | boolean | null | YamlValue[] | Record<string, YamlValue>;

export interface VendorEntry {
  id: string;
  name: string;
  category: string;
  service: string;
  owner: string;
  riskScore: number;
  criticality: string;
  currency: string;
  reviewDate: string;
  reviewCadenceMonths?: number;
  dataClassification?: string;
  notes?: string;
}

export interface VendorRegistry {
  schemaVersion: number;
  lastUpdated: string;
  allowedCurrencies: string[];
  vendors: VendorEntry[];
}

export interface InventoryReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: string;
}

export const DEFAULT_REGISTRY_PATH = "docs/security/vendors.yaml";
export const STALE_THRESHOLD_MONTHS = 12;
export const WARN_THRESHOLD_MONTHS = 9;
export const VALID_CRITICALITY = ["low", "medium", "high", "critical"];

// ---------------------------------------------------------------------------
// Minimal YAML subset parser (block maps/sequences + scalars)
// ---------------------------------------------------------------------------

interface YamlLine {
  indent: number;
  text: string;
  line: number;
}

class YamlParseError extends Error {
  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "YamlParseError";
  }
}

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) return raw.slice(0, i);
  }
  return raw;
}

function parseScalar(text: string): YamlValue {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function splitKeyValue(text: string): { key: string; rest: string } {
  const idx = text.indexOf(":");
  if (idx === -1) throw new YamlParseError(`expected "key: value"`);
  return { key: text.slice(0, idx).trim(), rest: text.slice(idx + 1).trim() };
}

function parseBlock(lines: YamlLine[], state: { pos: number }, indent: number): YamlValue {
  if (state.pos >= lines.length) return {};
  const first = lines[state.pos];
  if (first.indent < indent) return {};
  if (first.indent > indent) {
    throw new YamlParseError(`unexpected indentation (${first.text})`, first.line);
  }

  if (isSequenceItem(first.text)) {
    const items: YamlValue[] = [];
    while (state.pos < lines.length) {
      const line = lines[state.pos];
      if (line.indent !== indent || !isSequenceItem(line.text)) break;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "") {
        state.pos++;
        items.push(parseBlock(lines, state, line.indent + 2));
      } else if (rest.includes(":")) {
        state.pos++;
        const { key, rest: valueRest } = splitKeyValue(rest);
        const item: Record<string, YamlValue> = {};
        if (valueRest !== "") {
          item[key] = parseScalar(valueRest);
        } else {
          item[key] = parseBlock(lines, state, lines[state.pos]?.indent ?? line.indent + 2);
        }
        while (state.pos < lines.length && lines[state.pos].indent > line.indent) {
          const nested = lines[state.pos];
          if (isSequenceItem(nested.text)) {
            items.push(...(parseBlock(lines, state, nested.indent) as YamlValue[]));
            continue;
          }
          const { key: nk, rest: nv } = splitKeyValue(nested.text);
          if (nv === "") {
            state.pos++;
            item[nk] = parseBlock(lines, state, lines[state.pos]?.indent ?? nested.indent + 2);
          } else {
            item[nk] = parseScalar(nv);
            state.pos++;
          }
        }
        items.push(item);
      } else {
        items.push(parseScalar(rest));
        state.pos++;
      }
    }
    return items;
  }

  const map: Record<string, YamlValue> = {};
  while (state.pos < lines.length) {
    const line = lines[state.pos];
    if (line.indent !== indent || isSequenceItem(line.text)) break;
    const { key, rest } = splitKeyValue(line.text);
    if (rest === "") {
      const childIndent = lines[state.pos + 1]?.indent ?? indent + 2;
      if (childIndent <= indent) {
        throw new YamlParseError(`missing value for key "${key}"`, line.line);
      }
      state.pos++;
      map[key] = parseBlock(lines, state, childIndent);
    } else {
      map[key] = parseScalar(rest);
      state.pos++;
    }
  }
  return map;
}

export function parseYaml(source: string): YamlValue {
  const lines: YamlLine[] = [];
  source.split(/\r?\n/).forEach((raw, idx) => {
    const stripped = stripComment(raw);
    const trimmed = stripped.trim();
    if (trimmed === "") return;
    const indent = stripped.length - stripped.trimStart().length;
    lines.push({ indent, text: trimmed, line: idx + 1 });
  });
  if (lines.length === 0) return {};
  const state = { pos: 0 };
  const value = parseBlock(lines, state, lines[0].indent);
  if (state.pos !== lines.length) {
    throw new YamlParseError(
      `unexpected trailing content ("${lines[state.pos].text}")`,
      lines[state.pos].line,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Registry parsing + validation
// ---------------------------------------------------------------------------

function asRecord(value: YamlValue, what: string): Record<string, YamlValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a mapping`);
  }
  return value;
}

function asString(value: YamlValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function asInt(value: YamlValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`"${field}" must be an integer`);
  }
  return value;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRegistry(root: YamlValue): VendorRegistry {
  const record = asRecord(root, "registry");
  const schemaVersion = asInt(record.schema_version, "schema_version");
  if (schemaVersion !== 1) {
    throw new Error(`unsupported schema_version ${schemaVersion} (expected 1)`);
  }
  const lastUpdated = asString(record.last_updated, "last_updated");
  if (!DATE_RE.test(lastUpdated)) {
    throw new Error(`"last_updated" must be a YYYY-MM-DD date`);
  }
  const allowed = record.allowed_currencies;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    throw new Error(`"allowed_currencies" must be a non-empty list`);
  }
  const allowedCurrencies = allowed.map((c) => asString(c, "allowed_currencies entry"));
  const vendorsRaw = record.vendors;
  if (!Array.isArray(vendorsRaw)) {
    throw new Error(`"vendors" must be a list`);
  }
  const vendors = vendorsRaw.map((raw) => {
    const v = asRecord(raw, "vendor entry");
    const entry: VendorEntry = {
      id: asString(v.id, "id"),
      name: asString(v.name, "name"),
      category: asString(v.category, "category"),
      service: asString(v.service, "service"),
      owner: asString(v.owner, "owner"),
      riskScore: asInt(v.risk_score, "risk_score"),
      criticality: asString(v.criticality, "criticality"),
      currency: asString(v.currency, "currency"),
      reviewDate: asString(v.review_date, "review_date"),
    };
    if (v.review_cadence_months !== undefined) {
      entry.reviewCadenceMonths = asInt(v.review_cadence_months, "review_cadence_months");
    }
    if (v.data_classification !== undefined) {
      entry.dataClassification = asString(v.data_classification, "data_classification");
    }
    if (v.notes !== undefined) {
      entry.notes = asString(v.notes, "notes");
    }
    return entry;
  });
  return { schemaVersion, lastUpdated, allowedCurrencies, vendors };
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateRegistry(reg: VendorRegistry, now: Date = new Date()): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  reg.vendors.forEach((vendor) => {
    const tag = `[${vendor.id}]`;

    if (seen.has(vendor.id)) {
      errors.push(`${tag} duplicate vendor entry`);
    }
    seen.add(vendor.id);

    if (!/^[a-z0-9][a-z0-9-]*$/.test(vendor.id)) {
      errors.push(`${tag} id must match ^[a-z0-9][a-z0-9-]*$`);
    }
    if (vendor.riskScore < 1 || vendor.riskScore > 5) {
      errors.push(`${tag} risk_score must be an integer between 1 and 5`);
    }
    if (!VALID_CRITICALITY.includes(vendor.criticality)) {
      errors.push(`${tag} criticality must be one of ${VALID_CRITICALITY.join(", ")}`);
    }
    if (!reg.allowedCurrencies.includes(vendor.currency)) {
      errors.push(`${tag} currency "${vendor.currency}" is not in allowed_currencies`);
    }
    if (!validDate(vendor.reviewDate)) {
      errors.push(`${tag} review_date must be a valid YYYY-MM-DD date`);
    } else {
      const review = new Date(`${vendor.reviewDate}T00:00:00Z`);
      if (review.getTime() > now.getTime()) {
        errors.push(`${tag} review_date cannot be in the future`);
      }
    }
    if (vendor.reviewCadenceMonths !== undefined && vendor.reviewCadenceMonths < 1) {
      errors.push(`${tag} review_cadence_months must be >= 1`);
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// Freshness + currency-change checks
// ---------------------------------------------------------------------------

function monthsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

export function checkFreshness(
  reg: VendorRegistry,
  now: Date = new Date(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  reg.vendors.forEach((vendor) => {
    if (!validDate(vendor.reviewDate)) return;
    const review = new Date(`${vendor.reviewDate}T00:00:00Z`);
    const ageMonths = monthsBetween(review, now);
    const cadence = vendor.reviewCadenceMonths ?? STALE_THRESHOLD_MONTHS;
    const staleAt = Math.min(cadence, STALE_THRESHOLD_MONTHS);
    if (ageMonths > staleAt) {
      errors.push(
        `[${vendor.id}] review is ${ageMonths.toFixed(1)} months old; older than the ${staleAt}-month limit ` +
          `(last reviewed ${vendor.reviewDate})`,
      );
    } else if (ageMonths > WARN_THRESHOLD_MONTHS) {
      warnings.push(
        `[${vendor.id}] review is ${ageMonths.toFixed(1)} months old; review due within ` +
          `${(staleAt - ageMonths).toFixed(1)} months (last reviewed ${vendor.reviewDate})`,
      );
    }
  });

  return { errors, warnings };
}

/** A currency change must be accompanied by a fresh review of the vendor. */
export function detectCurrencyChanges(prev: VendorRegistry, next: VendorRegistry): string[] {
  const errors: string[] = [];
  const prevById = new Map(prev.vendors.map((v) => [v.id, v]));
  next.vendors.forEach((vendor) => {
    const before = prevById.get(vendor.id);
    if (before && before.currency !== vendor.currency) {
      if (before.reviewDate === vendor.reviewDate) {
        errors.push(
          `[${vendor.id}] currency changed (${before.currency} -> ${vendor.currency}) but review_date was ` +
            `not updated; a fresh review is required`,
        );
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Report + summary
// ---------------------------------------------------------------------------

export function buildSummary(
  reg: VendorRegistry,
  errors: string[],
  warnings: string[],
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  lines.push("## SOC2 Vendor Inventory Summary");
  lines.push("");
  lines.push(`- Vendors: ${reg.vendors.length}`);
  if (errors.length === 0) {
    lines.push("- Freshness: all entries are within the 12-month review limit");
  } else {
    lines.push(
      `- Freshness: ${errors.filter((e) => e.includes("older than the")).length} stale entr${errors.filter((e) => e.includes("older than the")).length === 1 ? "y" : "ies"}`,
    );
  }
  if (warnings.length > 0) {
    lines.push(`- Approaching review: ${warnings.length}`);
  }
  lines.push("");
  lines.push("Next reviews due:");
  const due: Array<{ id: string; date: string; when: string }> = [];
  reg.vendors.forEach((vendor) => {
    if (!validDate(vendor.reviewDate)) return;
    const cadence = vendor.reviewCadenceMonths ?? STALE_THRESHOLD_MONTHS;
    const review = new Date(`${vendor.reviewDate}T00:00:00Z`);
    const dueAt = new Date(review);
    dueAt.setUTCMonth(dueAt.getUTCMonth() + cadence);
    const months = monthsBetween(now, dueAt);
    const when =
      months < 0 ? "OVERDUE" : months <= 3 ? `in ${months.toFixed(1)} months` : "on track";
    due.push({ id: vendor.id, date: vendor.reviewDate, when });
  });
  due.forEach((d) => lines.push(`- \`${d.id}\` — last reviewed ${d.date}, ${d.when}`));
  if (due.length === 0) lines.push("- (none)");

  if (errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    errors.forEach((e) => lines.push(`- [ERROR] ${e}`));
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    warnings.forEach((w) => lines.push(`- [WARN] ${w}`));
  }
  return lines.join("\n");
}

export function runCheck(
  source: string,
  baseSource: string | null,
  now: Date = new Date(),
): InventoryReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let registry: VendorRegistry;
  try {
    registry = parseRegistry(parseYaml(source));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [`registry could not be parsed: ${message}`],
      warnings: [],
      summary: `## SOC2 Vendor Inventory Summary\n\nRegistry could not be parsed:\n- ❌ ${message}`,
    };
  }

  errors.push(...validateRegistry(registry, now));
  const freshness = checkFreshness(registry, now);
  errors.push(...freshness.errors);
  warnings.push(...freshness.warnings);

  if (baseSource !== null) {
    try {
      const prev = parseRegistry(parseYaml(baseSource));
      errors.push(...detectCurrencyChanges(prev, registry));
    } catch {
      // Base registry could not be parsed (e.g. pre-schema shape): skip diff.
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: buildSummary(registry, errors, warnings, now),
  };
}

// ---------------------------------------------------------------------------
// CLI + PR comment
// ---------------------------------------------------------------------------

function postComment(body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const pr = process.env.PR_NUMBER;
    if (!token || !repo || !pr) {
      resolve();
      return;
    }
    const data = JSON.stringify({ body });
    const req = https.request(
      `https://api.github.com/repos/${repo}/issues/${pr}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "User-Agent": "vendor-inventory-check",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          console.log(`Comment failed. Status: ${res.statusCode}`);
          resolve();
          return;
        }
        console.log("Comment posted. Status:", res.statusCode);
        resolve();
      },
    );
    req.on("error", (e) => reject(e));
    req.write(data);
    req.end();
  });
}

export function readBaseRegistry(baseSha: string | undefined, path: string): string | null {
  if (!baseSha) return null;
  try {
    return execSync(`git show ${baseSha}:${path}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export async function main(): Promise<number> {
  const registryPath = process.argv[2] ?? DEFAULT_REGISTRY_PATH;
  let source: string;
  try {
    source = fs.readFileSync(registryPath, "utf8");
  } catch (err) {
    console.error(
      `ERROR: cannot read registry at "${registryPath}": ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }

  const baseSource = readBaseRegistry(process.env.BASE_SHA, registryPath);
  const report = runCheck(source, baseSource);

  console.log(report.summary);
  console.log("");
  if (report.ok) {
    console.log("Vendor inventory OK.");
  } else {
    console.error(`Vendor inventory FAILED with ${report.errors.length} error(s).`);
  }

  try {
    await postComment(report.summary);
  } catch (err) {
    console.error("Error posting comment:", err);
  }
  return report.ok ? 0 : 1;
}

const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("vendor-inventory-check.ts") ||
    process.argv[1] === new URL(import.meta.url).pathname);

if (isMainModule) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

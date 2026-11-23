/**
 * auditExportService.ts
 * ---------------------
 * Produces signed, integrity-protected exports of the audit event log.
 *
 * ## Export format
 * Each export now contains two sections:
 *
 *   1. **Raw events** – PII-redacted NDJSON lines, one audit event per line
 *      (unchanged from the original implementation).
 *
 *   2. **Analytics summary** – A single JSON object appended as the last line
 *      of the export, tagged with `"_type": "analytics_summary"`. It contains
 *      per-action and per-service aggregate counts with Laplace differential-
 *      privacy noise applied, together with full DP metadata so consumers know
 *      exactly what privacy guarantee was used.
 *
 * ## Differential privacy
 * Aggregate counts (actions per service, events per action) have Laplace noise
 * added before export so that the presence or absence of any single event
 * cannot be inferred from the published totals. Parameters:
 *
 *   - **epsilon** (ε): controls noise magnitude. Lower ε → more noise → stronger
 *     privacy. Configured via `CHRONOPAY_DP_EPSILON` env var (default 1.0).
 *   - **sensitivity**: fixed at 1 for COUNT queries (adding/removing one event
 *     changes any aggregate by at most 1).
 *
 * Each export call charges ε against the `audit_events` epsilon budget tracked
 * by {@link EpsilonBudgetTracker}. When the budget is exhausted the export is
 * blocked and a {@link BudgetExhaustedError} is thrown.
 *
 * ## Disabling DP
 * Set `CHRONOPAY_DP_ENABLED=false` to skip noise (useful for local dev/debug).
 * The analytics summary is still included but will show exact counts.
 *
 * @module auditExportService
 */

import fs from "fs/promises";
import crypto from "node:crypto";
import { decodeAuditEvent, redactSensitiveData } from "../utils/auditEventValidator.js";
import { AuditLogger } from "./auditLogger.js";
import { EphemeralStore, InMemoryEphemeralStore } from "./ephemeralStore.js";
import { JobQueue } from "./jobQueue.js";
import {
  applyLaplaceNoiseToCountMap,
  buildDPMetadata,
  validateEpsilon,
  DifferentialPrivacyMetadata,
  LaplaceParams,
} from "../utils/differentialPrivacy.js";
import {
  EpsilonBudgetTracker,
  BudgetExhaustedError,
  defaultEpsilonBudgetTracker,
} from "./epsilonBudgetTracker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dataset identifier used for budget accounting. */
const AUDIT_DATASET_ID = "audit_events";

/** Default epsilon per export when CHRONOPAY_DP_EPSILON is not set. */
const DEFAULT_DP_EPSILON = 1.0;

/** L1 sensitivity for a COUNT query: adding/removing 1 record changes count by 1. */
const COUNT_SENSITIVITY = 1;

const DEFAULT_EXPORT_TTL_SECONDS = 300;
const DOWNLOAD_PATH = "/api/v1/admin/audit/export/download";

// ---------------------------------------------------------------------------
// Existing types (unchanged)
// ---------------------------------------------------------------------------

export interface AuditExportResult {
  downloadUrl: string;
  integrity: string;
  expiresAt: number;
}

interface StoredAuditExport {
  content: string;
  integrity: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Analytics types (new)
// ---------------------------------------------------------------------------

/** Raw (pre-noise) aggregate counts derived from the audit log. */
export interface AuditAnalyticsRaw {
  totalEvents: number;
  /** Event counts grouped by action string. */
  countsByAction: Record<string, number>;
  /** Event counts grouped by service name. */
  countsByService: Record<string, number>;
}

/** DP-noised analytics summary embedded in the export. */
export interface AuditAnalyticsSummary {
  _type: "analytics_summary";
  /** Noised total event count. */
  totalEvents: number;
  /** Noised per-action counts. */
  countsByAction: Record<string, number>;
  /** Noised per-service counts. */
  countsByService: Record<string, number>;
  /** Full description of the DP parameters and mechanism used. */
  differentialPrivacy: DifferentialPrivacyMetadata;
  /**
   * When DP is disabled (CHRONOPAY_DP_ENABLED=false) this flag is true so
   * consumers know exact counts are present.
   */
  dpDisabled?: true;
}

// ---------------------------------------------------------------------------
// Crypto helpers (unchanged)
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function buildToken(exportId: string, expiresAt: number, secret: string): string {
  const payload = `${exportId}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return Buffer.from(`${payload}:${signature}`, "utf8").toString("base64url");
}

function parseToken(token: string, secret: string): { exportId: string; expiresAt: number } {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid export token");
  }

  const parts = decoded.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid export token");
  }

  const [exportId, expiresAtString, providedSignature] = parts;
  const expiresAt = Number(expiresAtString);

  if (!exportId || Number.isNaN(expiresAt) || !providedSignature) {
    throw new Error("Invalid export token");
  }

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${exportId}:${expiresAt}`, "utf8")
    .digest("hex");

  if (!timingSafeEquals(expectedSignature, providedSignature)) {
    throw new Error("Invalid export token");
  }

  if (Date.now() > expiresAt) {
    throw new Error("Export token expired");
  }

  return { exportId, expiresAt };
}

// ---------------------------------------------------------------------------
// AuditExportService
// ---------------------------------------------------------------------------

export class AuditExportService {
  private get ttlSeconds(): number {
    return Number(process.env.CHRONOPAY_AUDIT_EXPORT_TTL_SECONDS ?? DEFAULT_EXPORT_TTL_SECONDS);
  }

  private get secret(): string {
    return process.env.CHRONOPAY_AUDIT_EXPORT_SECRET || "";
  }

  /** Epsilon for Laplace noise on this export. Validated at call time. */
  private get dpEpsilon(): number {
    const raw = process.env.CHRONOPAY_DP_EPSILON;
    if (raw !== undefined) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_DP_EPSILON;
  }

  /** When false, Laplace noise is skipped (exact counts are exported). */
  private get dpEnabled(): boolean {
    const val = process.env.CHRONOPAY_DP_ENABLED;
    if (val === undefined) return true;
    return val.toLowerCase() !== "false";
  }

  constructor(
    private readonly store: EphemeralStore<StoredAuditExport> = new InMemoryEphemeralStore<StoredAuditExport>(),
    private readonly queue: JobQueue = new JobQueue(),
    private readonly logger: AuditLogger = new AuditLogger(),
    private readonly budgetTracker: EpsilonBudgetTracker = defaultEpsilonBudgetTracker,
  ) {}

  // -------------------------------------------------------------------------
  // Public API (unchanged signatures)
  // -------------------------------------------------------------------------

  public async createExport(baseUrl: string): Promise<AuditExportResult> {
    if (!this.secret) {
      throw new Error("Audit export signing secret is not configured.");
    }

    // Validate epsilon early — before touching the queue or budget.
    if (this.dpEnabled) {
      validateEpsilon(this.dpEpsilon);
    }

    return this.queue.enqueue(async () => {
      // Charge epsilon budget before building the export. This ensures we
      // never serve an export when the budget is exhausted.
      if (this.dpEnabled) {
        // Throws BudgetExhaustedError if over limit — propagates to caller.
        await this.budgetTracker.charge(AUDIT_DATASET_ID, this.dpEpsilon);
      }

      const exportId = crypto.randomUUID();
      const exportData = await this.buildExportContent();
      const expiresAt = Date.now() + this.ttlSeconds * 1000;
      const integrity = sha256Hex(exportData);
      await this.store.set(exportId, { content: exportData, integrity, expiresAt }, this.ttlSeconds);

      const token = buildToken(exportId, expiresAt, this.secret);
      const downloadUrl = `${baseUrl}${DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;

      await this.logger.log(
        "audit.export.requested",
        {
          method: "POST",
          context: {
            expiresAt,
            exportId,
            dpEnabled: this.dpEnabled,
            dpEpsilon: this.dpEnabled ? this.dpEpsilon : null,
          },
        },
        { resource: "/api/v1/admin/audit/export", status: 200 },
      );

      return { downloadUrl, integrity, expiresAt };
    });
  }

  public async getExport(token: string): Promise<StoredAuditExport> {
    if (!this.secret) {
      throw new Error("Audit export signing secret is not configured.");
    }

    const { exportId } = parseToken(token, this.secret);
    const exportEntry = await this.store.get(exportId);
    if (!exportEntry) {
      throw new Error("Export not found or expired.");
    }

    const computedHash = sha256Hex(exportEntry.content);
    if (!timingSafeEquals(computedHash, exportEntry.integrity)) {
      await this.store.delete(exportId);
      throw new Error("Export integrity validation failed.");
    }

    await this.logger.log(
      "audit.export.downloaded",
      { method: "GET", context: { exportId } },
      { resource: "/api/v1/admin/audit/export/download", status: 200 },
    );

    return exportEntry;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Aggregate raw audit log lines into count maps. */
  private aggregateCounts(lines: string[]): AuditAnalyticsRaw {
    const countsByAction: Record<string, number> = {};
    const countsByService: Record<string, number> = {};
    let totalEvents = 0;

    for (const line of lines) {
      try {
        const event = decodeAuditEvent(line);
        totalEvents += 1;

        const action = typeof event.action === "string" ? event.action : "unknown";
        countsByAction[action] = (countsByAction[action] ?? 0) + 1;

        const service = typeof event.service === "string" ? event.service : "unknown";
        countsByService[service] = (countsByService[service] ?? 0) + 1;
      } catch {
        // Skip malformed lines — consistent with buildExportContent below.
      }
    }

    return { totalEvents, countsByAction, countsByService };
  }

  /**
   * Build the {@link AuditAnalyticsSummary} line appended to the export.
   *
   * When DP is enabled, Laplace noise is applied to all count maps using the
   * current epsilon. When DP is disabled, exact counts are used (dev/debug
   * only — not safe for production exports).
   */
  private buildAnalyticsSummary(raw: AuditAnalyticsRaw): AuditAnalyticsSummary {
    if (!this.dpEnabled) {
      // Exact counts — mark explicitly so consumers know.
      return {
        _type: "analytics_summary",
        totalEvents: raw.totalEvents,
        countsByAction: { ...raw.countsByAction },
        countsByService: { ...raw.countsByService },
        differentialPrivacy: buildDPMetadata(
          { epsilon: this.dpEpsilon, sensitivity: COUNT_SENSITIVITY },
          0,
        ),
        dpDisabled: true,
      };
    }

    const params: LaplaceParams = {
      epsilon: this.dpEpsilon,
      sensitivity: COUNT_SENSITIVITY,
    };

    // Noise each count map independently. totalEvents is a scalar so we wrap
    // it in a single-key map for uniform treatment.
    const noisedTotal = applyLaplaceNoiseToCountMap({ total: raw.totalEvents }, params);
    const noisedByAction = applyLaplaceNoiseToCountMap(raw.countsByAction, params);
    const noisedByService = applyLaplaceNoiseToCountMap(raw.countsByService, params);

    const dpMeta = buildDPMetadata(params, noisedTotal.noiseScale);

    return {
      _type: "analytics_summary",
      totalEvents: noisedTotal.counts["total"] ?? 0,
      countsByAction: noisedByAction.counts,
      countsByService: noisedByService.counts,
      differentialPrivacy: dpMeta,
    };
  }

  private async buildExportContent(): Promise<string> {
    let rawFile: string;
    const filePath = this.logger.getLogFilePath();

    try {
      rawFile = await fs.readFile(filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        rawFile = "";
      } else {
        throw error;
      }
    }

    const lines = rawFile.split(/\r?\n/).filter(Boolean);

    // 1. Redacted event lines (original behaviour).
    const redactedLines = lines
      .map((line) => {
        try {
          const event = decodeAuditEvent(line);
          return JSON.stringify({
            ...event,
            data: redactSensitiveData(event.data),
          });
        } catch {
          return null;
        }
      })
      .filter((line): line is string => line !== null);

    // 2. Analytics summary with DP noise.
    const raw = this.aggregateCounts(lines);
    const summary = this.buildAnalyticsSummary(raw);
    const summaryLine = JSON.stringify(summary);

    const allLines = [...redactedLines, summaryLine];
    return allLines.length > 0 ? `${allLines.join("\n")}\n` : "";
  }
}

export { BudgetExhaustedError };
export const auditExportService = new AuditExportService();

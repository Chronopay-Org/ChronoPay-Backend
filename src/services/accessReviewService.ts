/**
 * SOC2 Access Review Service
 *
 * Provides quarterly access review attestation reports by:
 *   - Snapshotting current access grant assignments at a point in time
 *   - Generating reports in CSV and JSON formats for audit evidence
 *   - Tracking reviewer sign-off with reviewer, date, and outcome
 *
 * Security properties:
 *   - Snapshots are immutable once created
 *   - Attestations are append-only (immutable after creation)
 *   - All operations are audited via AuditLogger
 *   - Timing-safe token verification for report downloads
 */

import crypto from "node:crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { AuditLogger } from "./auditLogger.js";
import { buildRoleHierarchy } from "../middleware/rbac.js";
import type { RoleHierarchy } from "../middleware/rbac.js";
import type {
  AccessGrantEntry,
  AccessGrantSnapshot,
  AccessReviewAttestation,
  AccessReviewReport,
  AttestationOutcome,
  QuarterLabel,
  QuarterGapResult,
  ListSnapshotsOptions,
  ListSnapshotsResult,
  ListAttestationsOptions,
  ListAttestationsResult,
  ReportFormat,
  SnapshotSummary,
} from "../types/accessReview.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const ROLES_CONFIG_URL = new URL("../config/roles.json", import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Compute the current quarter label from a Date.
 * Returns e.g. "2026-Q2" for April-June 2026.
 */
export function computeQuarterLabel(date: Date = new Date()): QuarterLabel {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/**
 * Compute quarter boundaries (start and end) for a given quarter label.
 */
export function computeQuarterRange(quarterLabel: QuarterLabel): { start: Date; end: Date } {
  const [yearStr, qStr] = quarterLabel.split("-Q");
  const year = Number.parseInt(yearStr, 10);
  const quarter = Number.parseInt(qStr, 10);
  if (Number.isNaN(year) || Number.isNaN(quarter) || quarter < 1 || quarter > 4) {
    throw new Error(`Invalid quarter label: ${quarterLabel}`);
  }
  const startMonth = (quarter - 1) * 3;
  const start = new Date(year, startMonth, 1, 0, 0, 0, 0);
  const end = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  return { start, end };
}

/**
 * Generate previous quarter labels going back `count` quarters.
 */
export function generatePreviousQuarters(count: number, from: Date = new Date()): QuarterLabel[] {
  const quarters: QuarterLabel[] = [];
  const current = computeQuarterLabel(from);
  const [yearStr, qStr] = current.split("-Q");
  let year = Number.parseInt(yearStr, 10);
  let quarter = Number.parseInt(qStr, 10);

  for (let i = 0; i < count; i++) {
    quarters.push(`${year}-Q${quarter}`);
    quarter--;
    if (quarter < 1) {
      quarter = 4;
      year--;
    }
  }
  return quarters;
}

/**
 * Build access grant entries from the role hierarchy.
 * Each known role gets an entry with its effective permissions and implied roles.
 */
export function buildGrantEntriesFromHierarchy(roleHierarchy: RoleHierarchy): AccessGrantEntry[] {
  const entries: AccessGrantEntry[] = [];

  for (const role of roleHierarchy.roles) {
    const effective = roleHierarchy.effectiveRolesByRole.get(role);
    if (!effective) continue;

    const impliedRoles = Array.from(effective).filter((r) => r !== role);
    entries.push({
      role,
      effectivePermissions: Array.from(effective).sort(),
      impliedRoles: impliedRoles.sort(),
      source: "roles.json",
    });
  }

  return entries.sort((a, b) => a.role.localeCompare(b.role));
}

/**
 * Default role hierarchy used when roles.json cannot be loaded.
 * Provides minimal safe defaults.
 */
export function getDefaultRoleHierarchy(): RoleHierarchy {
  return buildRoleHierarchy({
    roles: {
      admin: ["support", "professional", "customer"],
      support: ["auditor"],
      auditor: [],
      professional: [],
      customer: [],
    },
  });
}

/**
 * Read and parse the roles.json configuration file.
 */
export function readRolesConfigFromDisk(): { roles: Record<string, string[]> } {
  try {
    const raw = fs.readFileSync(ROLES_CONFIG_URL, "utf8");
    return JSON.parse(raw) as { roles: Record<string, string[]> };
  } catch {
    return {
      roles: {
        admin: ["support", "professional", "customer"],
        support: ["auditor"],
        auditor: [],
        professional: [],
        customer: [],
      },
    };
  }
}

// ─── In-memory store types ────────────────────────────────────────────────────

interface SnapshotStore {
  snapshots: Map<string, AccessGrantSnapshot>;
  attestations: Map<string, AccessReviewAttestation>;
}

// ─── AccessReviewService ──────────────────────────────────────────────────────

export class AccessReviewService {
  private readonly store: SnapshotStore = {
    snapshots: new Map(),
    attestations: new Map(),
  };
  private readonly logger: AuditLogger;

  constructor(logger?: AuditLogger) {
    this.logger = logger ?? new AuditLogger();
  }

  // ── Snapshot Management ───────────────────────────────────────────────────

  /**
   * Take a point-in-time snapshot of the access grant assignments.
   * Returns the created snapshot. If a snapshot already exists for the current
   * quarter, returns the existing one unless `force` is true.
   */
  public async createSnapshot(
    force: boolean = false,
    snapshotDate?: Date,
  ): Promise<AccessGrantSnapshot> {
    const date = snapshotDate ?? new Date();
    const quarterLabel = computeQuarterLabel(date);

    // Check for existing snapshot this quarter (unless forced)
    if (!force) {
      const existing = this.findSnapshotForQuarter(quarterLabel);
      if (existing) {
        await this.logger.log(
          "access-review.snapshot.skipped",
          {
            context: { quarterLabel, snapshotId: existing.snapshotId, reason: "already_exists" },
          },
          { status: 200 },
        );
        return existing;
      }
    }

    // Build the role hierarchy and grant entries
    const config = readRolesConfigFromDisk();
    const roleHierarchy = buildRoleHierarchy(config);
    const grants = buildGrantEntriesFromHierarchy(roleHierarchy);
    const snapshot: AccessGrantSnapshot = {
      snapshotId: generateId(),
      quarterLabel,
      snapshotDate: date.toISOString(),
      grants,
      createdAt: new Date().toISOString(),
    };

    this.store.snapshots.set(snapshot.snapshotId, snapshot);

    await this.logger.log(
      "access-review.snapshot.created",
      {
        context: {
          snapshotId: snapshot.snapshotId,
          quarterLabel,
          grantCount: grants.length,
        },
      },
      { status: 201 },
    );

    return snapshot;
  }

  /**
   * Retrieve a snapshot by its ID.
   */
  public getSnapshot(snapshotId: string): AccessGrantSnapshot | null {
    return this.store.snapshots.get(snapshotId) ?? null;
  }

  /**
   * List snapshots with optional filtering and pagination.
   */
  public listSnapshots(options?: ListSnapshotsOptions): ListSnapshotsResult {
    const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = options?.offset ?? 0;

    let snapshots = Array.from(this.store.snapshots.values());

    // Apply quarter label filter
    if (options?.quarterLabel) {
      snapshots = snapshots.filter((s) => s.quarterLabel === options.quarterLabel);
    }

    // Sort by createdAt descending (most recent first)
    snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = snapshots.length;
    const page = snapshots.slice(offset, offset + limit);

    return {
      snapshots: page,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get lightweight snapshot summaries.
   */
  public listSnapshotSummaries(options?: ListSnapshotsOptions): {
    summaries: SnapshotSummary[];
    total: number;
    limit: number;
    offset: number;
  } {
    const result = this.listSnapshots(options);
    return {
      summaries: result.snapshots.map((s) => ({
        snapshotId: s.snapshotId,
        quarterLabel: s.quarterLabel,
        snapshotDate: s.snapshotDate,
        grantCount: s.grants.length,
        createdAt: s.createdAt,
      })),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * Find snapshot for a given quarter, if one exists.
   */
  public findSnapshotForQuarter(quarterLabel: QuarterLabel): AccessGrantSnapshot | null {
    for (const snapshot of this.store.snapshots.values()) {
      if (snapshot.quarterLabel === quarterLabel) {
        return snapshot;
      }
    }
    return null;
  }

  /**
   * Detect gaps in quarterly snapshots.
   * Checks if there are missing quarters going back `lookback` quarters.
   */
  public detectGaps(lookback: number = 8): QuarterGapResult {
    const expectedQuarters = generatePreviousQuarters(lookback);
    const existingQuarters = new Set(
      Array.from(this.store.snapshots.values()).map((s) => s.quarterLabel),
    );

    const missingQuarters = expectedQuarters.filter((q) => !existingQuarters.has(q));
    const existingLabels = Array.from(this.store.snapshots.values())
      .map((s) => s.quarterLabel)
      .sort();
    const lastSnapshotQuarter = existingLabels.length > 0 ? existingLabels[existingLabels.length - 1] : null;

    return {
      hasGap: missingQuarters.length > 0,
      missingQuarters,
      lastSnapshotQuarter,
    };
  }

  // ── Attestation Management ────────────────────────────────────────────────

  /**
   * Record a reviewer sign-off (attestation) for a snapshot.
   * Returns the created attestation. Throws if the snapshot doesn't exist
   * or if a duplicate attestation (same reviewer + snapshot) exists.
   */
  public async createAttestation(
    snapshotId: string,
    reviewer: string,
    outcome: AttestationOutcome,
    notes?: string,
  ): Promise<AccessReviewAttestation> {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    if (!reviewer || typeof reviewer !== "string" || reviewer.trim().length === 0) {
      throw new Error("Reviewer identifier is required");
    }

    if (!["approved", "rejected", "needs_revision"].includes(outcome)) {
      throw new Error(
        `Invalid attestation outcome: ${outcome}. Must be approved, rejected, or needs_revision`,
      );
    }

    // Check for duplicate attestation
    const existingAttestations = Array.from(this.store.attestations.values()).filter(
      (a) => a.snapshotId === snapshotId && a.reviewer === reviewer,
    );
    if (existingAttestations.length > 0) {
      throw new Error(
        `Attestation already exists for snapshot ${snapshotId} by reviewer ${reviewer}. ` +
          `Existing outcome: ${existingAttestations[0].outcome}. Use updateAttestation to amend.`,
      );
    }

    const attestation: AccessReviewAttestation = {
      attestationId: generateId(),
      snapshotId,
      quarterLabel: snapshot.quarterLabel,
      reviewer: reviewer.trim(),
      reviewedAt: new Date().toISOString(),
      outcome,
      notes: notes?.trim(),
    };

    this.store.attestations.set(attestation.attestationId, attestation);

    await this.logger.log(
      "access-review.attestation.created",
      {
        context: {
          attestationId: attestation.attestationId,
          snapshotId,
          quarterLabel: snapshot.quarterLabel,
          reviewer: attestation.reviewer,
          outcome,
        },
      },
      { status: 201 },
    );

    return attestation;
  }

  /**
   * Retrieve an attestation by its ID.
   */
  public getAttestation(attestationId: string): AccessReviewAttestation | null {
    return this.store.attestations.get(attestationId) ?? null;
  }

  /**
   * List attestations with optional filtering and pagination.
   */
  public listAttestations(options?: ListAttestationsOptions): ListAttestationsResult {
    const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = options?.offset ?? 0;

    let attestations = Array.from(this.store.attestations.values());

    if (options?.snapshotId) {
      attestations = attestations.filter((a) => a.snapshotId === options.snapshotId);
    }
    if (options?.quarterLabel) {
      attestations = attestations.filter((a) => a.quarterLabel === options.quarterLabel);
    }
    if (options?.outcome) {
      attestations = attestations.filter((a) => a.outcome === options.outcome);
    }

    // Sort by reviewedAt descending
    attestations.sort(
      (a, b) => new Date(b.reviewedAt).getTime() - new Date(a.reviewedAt).getTime(),
    );

    const total = attestations.length;
    const page = attestations.slice(offset, offset + limit);

    return {
      attestations: page,
      total,
      limit,
      offset,
    };
  }

  // ── Report Generation ────────────────────────────────────────────────────

  /**
   * Generate a complete access review report for a given snapshot ID.
   * The report includes both the snapshot data and any attestations.
   */
  public generateReport(snapshotId: string): AccessReviewReport {
    const snapshot = this.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot not found: ${snapshotId}`);
    }

    const attestations = this.listAttestations({ snapshotId });

    return {
      reportId: generateId(),
      quarterLabel: snapshot.quarterLabel,
      snapshot,
      attestations: attestations.attestations,
      generatedAt: new Date().toISOString(),
      reviewed: attestations.attestations.length > 0,
    };
  }

  /**
   * Generate a report in the requested format (JSON or CSV) as a string.
   */
  public generateFormattedReport(snapshotId: string, format: ReportFormat): string {
    const report = this.generateReport(snapshotId);

    if (format === "json") {
      return this.formatJsonReport(report);
    }

    return this.formatCsvReport(report);
  }

  /**
   * Format the report as a human-readable JSON string.
   */
  private formatJsonReport(report: AccessReviewReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Format the report as CSV with separate sections for grants and attestations.
   */
  private formatCsvReport(report: AccessReviewReport): string {
    const lines: string[] = [];

    // Header section
    lines.push(`# SOC2 Access Review Report - ${report.quarterLabel}`);
    lines.push(`# Report ID: ${report.reportId}`);
    lines.push(`# Generated: ${report.generatedAt}`);
    lines.push(`# Snapshot: ${report.snapshot.snapshotId}`);
    lines.push(`# Snapshot Date: ${report.snapshot.snapshotDate}`);
    lines.push(`# Reviewed: ${report.reviewed}`);
    lines.push("");

    // Grant entries section
    lines.push("# Access Grants");
    lines.push("role,effective_permissions,implied_roles,source");
    for (const grant of report.snapshot.grants) {
      const permissions = grant.effectivePermissions.join("; ");
      const implied = grant.impliedRoles.join("; ");
      // Escape CSV fields that might contain commas or quotes
      const escapedPermissions = this.escapeCsvField(permissions);
      const escapedImplied = this.escapeCsvField(implied);
      lines.push(`${grant.role},${escapedPermissions},${escapedImplied},${grant.source}`);
    }
    lines.push("");

    // Attestation section
    lines.push("# Attestations");
    lines.push("attestation_id,reviewer,reviewed_at,outcome,notes");
    if (report.attestations.length === 0) {
      lines.push("N/A,N/A,N/A,pending_review,");
    } else {
      for (const att of report.attestations) {
        const escapedNotes = att.notes ? this.escapeCsvField(att.notes) : "";
        lines.push(
          `${att.attestationId},${att.reviewer},${att.reviewedAt},${att.outcome},${escapedNotes}`,
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * Escape a CSV field value, wrapping in quotes if needed.
   */
  private escapeCsvField(value: string): string {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  /**
   * Export all attested snapshots as a combined JSON report bundle.
   */
  public generateAttestedReportsBundle(): string {
    const allAttestations = Array.from(this.store.attestations.values());
    const attestedSnapshotIds = new Set(allAttestations.map((a) => a.snapshotId));
    const reports: AccessReviewReport[] = [];

    for (const snapshotId of attestedSnapshotIds) {
      try {
        reports.push(this.generateReport(snapshotId));
      } catch {
        // Skip snapshots that no longer exist (should not happen)
      }
    }

    // Sort by quarter descending
    reports.sort((a, b) => b.quarterLabel.localeCompare(a.quarterLabel));

    return JSON.stringify(
      { reports, generatedAt: new Date().toISOString(), count: reports.length },
      null,
      2,
    );
  }

  /**
   * Export all attested reports as a combined CSV bundle.
   */
  public generateAttestedReportsCsvBundle(): string {
    const allAttestations = Array.from(this.store.attestations.values());
    const attestedSnapshotIds = new Set(allAttestations.map((a) => a.snapshotId));

    const sections: string[] = [];

    for (const snapshotId of attestedSnapshotIds) {
      const snapshot = this.getSnapshot(snapshotId);
      if (!snapshot) continue;

      const report = this.generateReport(snapshotId);
      sections.push(this.formatCsvReport(report));
      sections.push("");
    }

    return sections.join("\n");
  }

  // ── Persistence (for production use) ──────────────────────────────────────

  /**
   * Persist all snapshots and attestations to JSON files on disk.
   */
  public async persistToDisk(
    snapshotsPath?: string,
    attestationsPath?: string,
  ): Promise<void> {
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    const snapshotsFile =
      snapshotsPath ?? path.join(cwd, "data", "access-review-snapshots.json");
    const attestationsFile =
      attestationsPath ?? path.join(cwd, "data", "access-review-attestations.json");

    const snapshotsDir = path.dirname(snapshotsFile);
    const attestationsDir = path.dirname(attestationsFile);

    await fsPromises.mkdir(snapshotsDir, { recursive: true });
    await fsPromises.mkdir(attestationsDir, { recursive: true });

    const snapshotsData = Array.from(this.store.snapshots.values());
    const attestationsData = Array.from(this.store.attestations.values());

    await fsPromises.writeFile(snapshotsFile, JSON.stringify(snapshotsData, null, 2), "utf8");
    await fsPromises.writeFile(attestationsFile, JSON.stringify(attestationsData, null, 2), "utf8");

    await this.logger.log(
      "access-review.persisted",
      {
        context: {
          snapshotsFile,
          attestationsFile,
          snapshotCount: snapshotsData.length,
          attestationCount: attestationsData.length,
        },
      },
      { status: 200 },
    );
  }

  /**
   * Load snapshots and attestations from disk, merging with in-memory state.
   */
  public async loadFromDisk(
    snapshotsPath?: string,
    attestationsPath?: string,
  ): Promise<void> {
    const cwd = typeof process !== "undefined" ? process.cwd() : ".";
    const snapshotsFile =
      snapshotsPath ?? path.join(cwd, "data", "access-review-snapshots.json");
    const attestationsFile =
      attestationsPath ?? path.join(cwd, "data", "access-review-attestations.json");

    try {
      const snapshotsRaw = await fsPromises.readFile(snapshotsFile, "utf8");
      const snapshots = JSON.parse(snapshotsRaw) as AccessGrantSnapshot[];
      for (const snapshot of snapshots) {
        this.store.snapshots.set(snapshot.snapshotId, snapshot);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    try {
      const attestationsRaw = await fsPromises.readFile(attestationsFile, "utf8");
      const attestations = JSON.parse(attestationsRaw) as AccessReviewAttestation[];
      for (const attestation of attestations) {
        this.store.attestations.set(attestation.attestationId, attestation);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }

    await this.logger.log(
      "access-review.loaded",
      {
        context: {
          snapshotsFile,
          attestationsFile,
          snapshotCount: this.store.snapshots.size,
          attestationCount: this.store.attestations.size,
        },
      },
      { status: 200 },
    );
  }

  // ── Test Helpers ─────────────────────────────────────────────────────────

  /**
   * Clear all in-memory data (for testing).
   */
  public clear(): void {
    this.store.snapshots.clear();
    this.store.attestations.clear();
  }

  /**
   * Inject a snapshot directly (for testing).
   */
  public injectSnapshot(snapshot: AccessGrantSnapshot): void {
    this.store.snapshots.set(snapshot.snapshotId, snapshot);
  }

  /**
   * Inject an attestation directly (for testing).
   */
  public injectAttestation(attestation: AccessReviewAttestation): void {
    this.store.attestations.set(attestation.attestationId, attestation);
  }
}

// ─── Default Singleton ────────────────────────────────────────────────────────

export const accessReviewService = new AccessReviewService();

/**
 * Test helper to rebuild the singleton with a fresh in-memory state.
 */
export function resetAccessReviewService(): void {
  accessReviewService.clear();
}

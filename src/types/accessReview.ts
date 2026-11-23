/**
 * SOC2 Access Review Types
 *
 * Domain types for quarterly access review attestation reports.
 * Captures snapshot of access grants, reviewer sign-offs, and report formats.
 */

/** Quarter label in ISO-like format, e.g. "2026-Q2" */
export type QuarterLabel = string;

/** Known roles as defined in the role hierarchy */
export interface AccessGrantEntry {
  /** The role name (e.g. "admin", "support") */
  role: string;
  /** All effective permissions derived from the role hierarchy */
  effectivePermissions: string[];
  /** Roles that this role directly implies (from roles.json) */
  impliedRoles: string[];
  /** Source configuration that defines this grant */
  source: string;
}

/** Immutable point-in-time snapshot of access grants */
export interface AccessGrantSnapshot {
  /** Unique snapshot identifier (UUID v4) */
  snapshotId: string;
  /** Quarter this snapshot covers, e.g. "2026-Q2" */
  quarterLabel: QuarterLabel;
  /** ISO 8601 timestamp when the snapshot was taken */
  snapshotDate: string;
  /** The access grant entries captured */
  grants: AccessGrantEntry[];
  /** ISO 8601 timestamp when this record was created */
  createdAt: string;
}

/** Outcome of an access review attestation */
export type AttestationOutcome = "approved" | "rejected" | "needs_revision";

/** Reviewer sign-off for a quarterly access review */
export interface AccessReviewAttestation {
  /** Unique attestation identifier (UUID v4) */
  attestationId: string;
  /** The snapshot this attestation refers to */
  snapshotId: string;
  /** Quarter being attested */
  quarterLabel: QuarterLabel;
  /** Identifier of the reviewer who performed the review */
  reviewer: string;
  /** ISO 8601 timestamp when the review was performed */
  reviewedAt: string;
  /** Outcome of the review */
  outcome: AttestationOutcome;
  /** Optional notes or justification */
  notes?: string;
}

/** Options for listing snapshots */
export interface ListSnapshotsOptions {
  /** Filter by quarter label prefix */
  quarterLabel?: QuarterLabel;
  /** Maximum results (default 50, max 200) */
  limit?: number;
  /** Pagination offset (default 0) */
  offset?: number;
}

/** Result of listing snapshots */
export interface ListSnapshotsResult {
  snapshots: AccessGrantSnapshot[];
  total: number;
  limit: number;
  offset: number;
}

/** Options for listing attestations */
export interface ListAttestationsOptions {
  /** Filter by snapshot ID */
  snapshotId?: string;
  /** Filter by quarter label */
  quarterLabel?: QuarterLabel;
  /** Filter by outcome */
  outcome?: AttestationOutcome;
  /** Maximum results (default 50, max 200) */
  limit?: number;
  /** Pagination offset (default 0) */
  offset?: number;
}

/** Result of listing attestations */
export interface ListAttestationsResult {
  attestations: AccessReviewAttestation[];
  total: number;
  limit: number;
  offset: number;
}

/** Report format options */
export type ReportFormat = "json" | "csv";

/** A complete access review report combining snapshot and attestations */
export interface AccessReviewReport {
  reportId: string;
  quarterLabel: QuarterLabel;
  snapshot: AccessGrantSnapshot;
  attestations: AccessReviewAttestation[];
  generatedAt: string;
  reviewed: boolean;
}

/** Snapshot detection result when checking for gaps */
export interface QuarterGapResult {
  hasGap: boolean;
  missingQuarters: QuarterLabel[];
  lastSnapshotQuarter: QuarterLabel | null;
}

/** Summary of a snapshot (lightweight, without full grants list) */
export interface SnapshotSummary {
  snapshotId: string;
  quarterLabel: QuarterLabel;
  snapshotDate: string;
  grantCount: number;
  createdAt: string;
}

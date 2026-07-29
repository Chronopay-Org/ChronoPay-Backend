/**
 * Tests for AccessReviewService
 *
 * Covers:
 *   - Quarter label computation
 *   - Snapshot creation, deduplication, and forced overwrite
 *   - Attestation creation, validation, and duplicate detection
 *   - Report generation (JSON and CSV formats)
 *   - Gap detection
 *   - Bundled report generation
 *   - Edge cases: reviewer absent, mid-quarter role change, snapshot gap
 */

import {
  AccessReviewService,
  computeQuarterLabel,
  computeQuarterRange,
  generatePreviousQuarters,
  buildGrantEntriesFromHierarchy,
  getDefaultRoleHierarchy,
} from "../accessReviewService.js";
import type {
  AccessGrantSnapshot,
  AccessReviewAttestation,
} from "../../types/accessReview.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestSnapshot(
  overrides: Partial<AccessGrantSnapshot> = {},
): AccessGrantSnapshot {
  return {
    snapshotId: "test-snapshot-1",
    quarterLabel: "2026-Q2",
    snapshotDate: "2026-05-01T00:00:00.000Z",
    grants: [
      {
        role: "admin",
        effectivePermissions: ["admin", "auditor", "customer", "professional", "support"],
        impliedRoles: ["auditor", "customer", "professional", "support"],
        source: "roles.json",
      },
      {
        role: "auditor",
        effectivePermissions: ["auditor"],
        impliedRoles: [],
        source: "roles.json",
      },
    ],
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function createTestAttestation(
  overrides: Partial<AccessReviewAttestation> = {},
): AccessReviewAttestation {
  return {
    attestationId: "test-att-1",
    snapshotId: "test-snapshot-1",
    quarterLabel: "2026-Q2",
    reviewer: "reviewer-alice",
    reviewedAt: "2026-05-15T00:00:00.000Z",
    outcome: "approved",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AccessReviewService", () => {
  let service: AccessReviewService;

  beforeEach(() => {
    service = new AccessReviewService();
  });

  // ── Quarter Label Helpers (module-level functions) ───────────────────────

  describe("computeQuarterLabel (module-level)", () => {
    it("computes Q1 for January", () => {
      expect(computeQuarterLabel(new Date("2026-01-15"))).toBe("2026-Q1");
    });

    it("computes Q2 for April", () => {
      expect(computeQuarterLabel(new Date("2026-04-01"))).toBe("2026-Q2");
    });

    it("computes Q3 for July", () => {
      expect(computeQuarterLabel(new Date("2026-07-20"))).toBe("2026-Q3");
    });

    it("computes Q4 for December", () => {
      expect(computeQuarterLabel(new Date("2026-12-31"))).toBe("2026-Q4");
    });

    it("handles year boundary", () => {
      expect(computeQuarterLabel(new Date("2025-12-01"))).toBe("2025-Q4");
      expect(computeQuarterLabel(new Date("2026-01-01"))).toBe("2026-Q1");
    });
  });

  describe("computeQuarterRange (module-level)", () => {
    it("returns correct range for Q2 2026", () => {
      const range = computeQuarterRange("2026-Q2");
      expect(range.start.getFullYear()).toBe(2026);
      expect(range.start.getMonth()).toBe(3);
      expect(range.start.getDate()).toBe(1);
      expect(range.end.getMonth()).toBe(5);
      expect(range.end.getDate()).toBe(30);
    });

    it("throws on invalid quarter label", () => {
      expect(() => computeQuarterRange("invalid")).toThrow("Invalid quarter label");
    });

    it("throws on out-of-range quarter", () => {
      expect(() => computeQuarterRange("2026-Q5")).toThrow("Invalid quarter label");
    });
  });

  describe("generatePreviousQuarters (module-level)", () => {
    it("generates previous 2 quarters from Q2 2026", () => {
      const quarters = generatePreviousQuarters(2, new Date("2026-05-01"));
      expect(quarters).toEqual(["2026-Q2", "2026-Q1"]);
    });

    it("generates previous 4 quarters crossing a year boundary", () => {
      const quarters = generatePreviousQuarters(4, new Date("2026-02-01"));
      expect(quarters).toEqual(["2026-Q1", "2025-Q4", "2025-Q3", "2025-Q2"]);
    });

    it("generates empty array for zero count", () => {
      expect(generatePreviousQuarters(0)).toEqual([]);
    });
  });

  describe("buildGrantEntriesFromHierarchy", () => {
    it("builds grant entries from the default role hierarchy", () => {
      const hierarchy = getDefaultRoleHierarchy();
      const entries = buildGrantEntriesFromHierarchy(hierarchy);

      expect(entries.length).toBeGreaterThan(0);
      const roles = entries.map((e) => e.role);
      expect(roles).toContain("admin");
      expect(roles).toContain("support");
      expect(roles).toContain("auditor");
      expect(roles).toContain("professional");
      expect(roles).toContain("customer");

      const admin = entries.find((e) => e.role === "admin");
      expect(admin!.effectivePermissions).toContain("admin");
      expect(admin!.impliedRoles).toContain("customer");
    });

    it("sorts entries by role name", () => {
      const hierarchy = getDefaultRoleHierarchy();
      const entries = buildGrantEntriesFromHierarchy(hierarchy);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1].role.localeCompare(entries[i].role)).toBeLessThanOrEqual(0);
      }
    });
  });

  // ── Snapshot Creation ────────────────────────────────────────────────────

  describe("createSnapshot", () => {
    it("creates a snapshot with grant entries", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      expect(snapshot.snapshotId).toBeTruthy();
      expect(snapshot.quarterLabel).toBe("2026-Q2");
      expect(snapshot.grants.length).toBeGreaterThan(0);
      expect(snapshot.createdAt).toBeTruthy();

      const roleNames = snapshot.grants.map((g) => g.role);
      expect(roleNames).toContain("admin");
      expect(roleNames).toContain("support");
      expect(roleNames).toContain("auditor");

      const adminGrant = snapshot.grants.find((g) => g.role === "admin");
      expect(adminGrant).toBeTruthy();
      expect(adminGrant!.effectivePermissions).toContain("admin");
    });

    it("returns existing snapshot for same quarter without force", async () => {
      const snapshot1 = await service.createSnapshot(false, new Date("2026-05-01"));
      const snapshot2 = await service.createSnapshot(false, new Date("2026-06-15"));

      expect(snapshot2.snapshotId).toBe(snapshot1.snapshotId);
    });

    it("creates new snapshot when force=true", async () => {
      const snapshot1 = await service.createSnapshot(false, new Date("2026-05-01"));
      const snapshot2 = await service.createSnapshot(true, new Date("2026-06-15"));

      expect(snapshot2.snapshotId).not.toBe(snapshot1.snapshotId);
      expect(snapshot2.quarterLabel).toBe("2026-Q2");
    });

    it("creates different snapshots for different quarters", async () => {
      const snapshot1 = await service.createSnapshot(false, new Date("2026-01-01"));
      const snapshot2 = await service.createSnapshot(false, new Date("2026-04-01"));

      expect(snapshot1.quarterLabel).toBe("2026-Q1");
      expect(snapshot2.quarterLabel).toBe("2026-Q2");
    });
  });

  // ── Snapshot Retrieval ──────────────────────────────────────────────────

  describe("getSnapshot", () => {
    it("returns null for non-existent snapshot", () => {
      expect(service.getSnapshot("non-existent")).toBeNull();
    });

    it("returns a snapshot by ID", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      const retrieved = service.getSnapshot(snapshot.snapshotId);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.snapshotId).toBe(snapshot.snapshotId);
    });
  });

  describe("listSnapshots", () => {
    it("returns empty list when no snapshots exist", () => {
      const result = service.listSnapshots();
      expect(result.snapshots).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("returns snapshots ordered by creation date descending", async () => {
      // Use injected snapshots with explicit different createdAts to ensure ordering
      const s1 = createTestSnapshot({
        snapshotId: "snap-old",
        quarterLabel: "2026-Q1",
        createdAt: "2026-01-15T00:00:00.000Z",
      });
      const s2 = createTestSnapshot({
        snapshotId: "snap-new",
        quarterLabel: "2026-Q2",
        createdAt: "2026-04-15T00:00:00.000Z",
      });
      service.injectSnapshot(s1);
      service.injectSnapshot(s2);

      const result = service.listSnapshots();
      expect(result.total).toBe(2);
      expect(result.snapshots[0].snapshotId).toBe("snap-new");
      expect(result.snapshots[1].snapshotId).toBe("snap-old");
    });

    it("filters by quarter label", async () => {
      await service.createSnapshot(false, new Date("2026-01-01"));
      await service.createSnapshot(false, new Date("2026-04-01"));

      const result = service.listSnapshots({ quarterLabel: "2026-Q2" });
      expect(result.total).toBe(1);
      expect(result.snapshots[0].quarterLabel).toBe("2026-Q2");
    });

    it("respects limit and offset", async () => {
      const s1 = createTestSnapshot({ snapshotId: "s1", quarterLabel: "2026-Q1", createdAt: "2026-01-01T00:00:00.000Z" });
      const s2 = createTestSnapshot({ snapshotId: "s2", quarterLabel: "2026-Q2", createdAt: "2026-04-01T00:00:00.000Z" });
      service.injectSnapshot(s1);
      service.injectSnapshot(s2);

      const result = service.listSnapshots({ limit: 1, offset: 0 });
      expect(result.snapshots.length).toBe(1);
      expect(result.total).toBe(2);
    });
  });

  describe("listSnapshotSummaries", () => {
    it("returns lightweight summaries without full grants", async () => {
      await service.createSnapshot(false, new Date("2026-05-01"));
      const result = service.listSnapshotSummaries();
      expect(result.summaries.length).toBe(1);
      expect(result.summaries[0].grantCount).toBeGreaterThan(0);
      expect((result.summaries[0] as any).grants).toBeUndefined();
    });
  });

  describe("findSnapshotForQuarter", () => {
    it("returns null when no snapshot exists for quarter", () => {
      expect(service.findSnapshotForQuarter("2026-Q3")).toBeNull();
    });

    it("finds existing snapshot for quarter", async () => {
      await service.createSnapshot(false, new Date("2026-05-01"));
      const found = service.findSnapshotForQuarter("2026-Q2");
      expect(found).toBeTruthy();
      expect(found!.quarterLabel).toBe("2026-Q2");
    });
  });

  // ── Gap Detection ───────────────────────────────────────────────────────

  describe("detectGaps", () => {
    it("reports gaps when no snapshots exist", () => {
      const gaps = service.detectGaps(4);
      expect(gaps.hasGap).toBe(true);
      expect(gaps.missingQuarters.length).toBeGreaterThan(0);
      expect(gaps.lastSnapshotQuarter).toBeNull();
    });

    it("returns correct gap structure", () => {
      const result = service.detectGaps(4);
      expect(result).toHaveProperty("hasGap");
      expect(result).toHaveProperty("missingQuarters");
      expect(result).toHaveProperty("lastSnapshotQuarter");
    });
  });

  // ── Attestation Management ──────────────────────────────────────────────

  describe("createAttestation", () => {
    it("creates an attestation with valid inputs", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const attestation = await service.createAttestation(
        snapshot.snapshotId,
        "reviewer-alice",
        "approved",
      );

      expect(attestation.attestationId).toBeTruthy();
      expect(attestation.snapshotId).toBe(snapshot.snapshotId);
      expect(attestation.quarterLabel).toBe("2026-Q2");
      expect(attestation.reviewer).toBe("reviewer-alice");
      expect(attestation.outcome).toBe("approved");
      expect(attestation.reviewedAt).toBeTruthy();
    });

    it("creates attestation with notes", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const attestation = await service.createAttestation(
        snapshot.snapshotId,
        "reviewer-bob",
        "needs_revision",
        "Need to review customer role permissions",
      );

      expect(attestation.outcome).toBe("needs_revision");
      expect(attestation.notes).toBe("Need to review customer role permissions");
    });

    it("throws for non-existent snapshot", async () => {
      await expect(
        service.createAttestation("non-existent", "reviewer-alice", "approved"),
      ).rejects.toThrow("Snapshot not found");
    });

    it("throws for empty reviewer", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      await expect(
        service.createAttestation(snapshot.snapshotId, "", "approved"),
      ).rejects.toThrow("Reviewer identifier is required");
    });

    it("throws for invalid outcome", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      await expect(
        service.createAttestation(snapshot.snapshotId, "reviewer-alice", "invalid" as any),
      ).rejects.toThrow("Invalid attestation outcome");
    });

    it("throws for duplicate attestation (same reviewer + snapshot)", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      await service.createAttestation(snapshot.snapshotId, "reviewer-alice", "approved");

      await expect(
        service.createAttestation(snapshot.snapshotId, "reviewer-alice", "rejected"),
      ).rejects.toThrow("already exists");
    });

    it("allows different reviewers for the same snapshot", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      await service.createAttestation(snapshot.snapshotId, "reviewer-alice", "approved");
      const att2 = await service.createAttestation(snapshot.snapshotId, "reviewer-bob", "rejected");

      expect(att2.reviewer).toBe("reviewer-bob");
      expect(att2.outcome).toBe("rejected");
    });
  });

  describe("getAttestation", () => {
    it("returns null for non-existent attestation", () => {
      expect(service.getAttestation("non-existent")).toBeNull();
    });

    it("returns attestation by ID", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      const att = await service.createAttestation(snapshot.snapshotId, "reviewer-alice", "approved");

      const retrieved = service.getAttestation(att.attestationId);
      expect(retrieved).toBeTruthy();
      expect(retrieved!.attestationId).toBe(att.attestationId);
    });
  });

  describe("listAttestations", () => {
    it("returns empty list when no attestations exist", () => {
      const result = service.listAttestations();
      expect(result.attestations).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("filters by snapshot ID", async () => {
      const s1 = await service.createSnapshot(false, new Date("2026-01-01"));
      const s2 = await service.createSnapshot(false, new Date("2026-04-01"));

      await service.createAttestation(s1.snapshotId, "reviewer-alice", "approved");
      await service.createAttestation(s2.snapshotId, "reviewer-bob", "approved");

      const result = service.listAttestations({ snapshotId: s1.snapshotId });
      expect(result.total).toBe(1);
      expect(result.attestations[0].snapshotId).toBe(s1.snapshotId);
    });

    it("filters by outcome", async () => {
      const s1 = await service.createSnapshot(false, new Date("2026-05-01"));

      await service.createAttestation(s1.snapshotId, "reviewer-alice", "approved");
      await service.createAttestation(s1.snapshotId, "reviewer-bob", "rejected");

      const result = service.listAttestations({ outcome: "approved" });
      expect(result.total).toBe(1);
      expect(result.attestations[0].outcome).toBe("approved");
    });

    it("respects pagination", async () => {
      const s1 = await service.createSnapshot(false, new Date("2026-05-01"));

      await service.createAttestation(s1.snapshotId, "reviewer-alice", "approved");
      await service.createAttestation(s1.snapshotId, "reviewer-bob", "rejected");

      const result = service.listAttestations({ limit: 1, offset: 0 });
      expect(result.attestations.length).toBe(1);
      expect(result.total).toBe(2);
    });
  });

  // ── Report Generation ──────────────────────────────────────────────────

  describe("generateReport", () => {
    it("generates a report with snapshot and attestations", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      await service.createAttestation(snapshot.snapshotId, "reviewer-alice", "approved");

      const report = service.generateReport(snapshot.snapshotId);

      expect(report.reportId).toBeTruthy();
      expect(report.quarterLabel).toBe("2026-Q2");
      expect(report.snapshot.snapshotId).toBe(snapshot.snapshotId);
      expect(report.attestations.length).toBe(1);
      expect(report.reviewed).toBe(true);
    });

    it("reports reviewed=false when no attestations exist", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const report = service.generateReport(snapshot.snapshotId);
      expect(report.reviewed).toBe(false);
      expect(report.attestations).toEqual([]);
    });

    it("throws for non-existent snapshot", () => {
      expect(() => service.generateReport("non-existent")).toThrow("Snapshot not found");
    });
  });

  describe("generateFormattedReport", () => {
    it("generates JSON report", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const json = service.generateFormattedReport(snapshot.snapshotId, "json");
      const parsed = JSON.parse(json);

      expect(parsed.quarterLabel).toBe("2026-Q2");
      expect(parsed.snapshot).toBeTruthy();
      expect(parsed.snapshot.grants).toBeTruthy();
    });

    it("generates CSV report with expected sections", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const csv = service.generateFormattedReport(snapshot.snapshotId, "csv");

      expect(csv).toContain("# SOC2 Access Review Report");
      expect(csv).toContain("2026-Q2");
      expect(csv).toContain("# Access Grants");
      expect(csv).toContain("role,effective_permissions,implied_roles,source");
      expect(csv).toContain("# Attestations");
      expect(csv).toContain("attestation_id,reviewer,reviewed_at,outcome,notes");
    });

    it("CSV shows pending_review when no attestations exist", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      const csv = service.generateFormattedReport(snapshot.snapshotId, "csv");
      expect(csv).toContain("pending_review");
    });

    it("CSV includes attestation data when attestations exist", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      await service.createAttestation(snapshot.snapshotId, "reviewer-alice", "approved");

      const csv = service.generateFormattedReport(snapshot.snapshotId, "csv");
      expect(csv).toContain("reviewer-alice");
      expect(csv).toContain("approved");
    });
  });

  // ── Bundled Reports ─────────────────────────────────────────────────────

  describe("generateAttestedReportsBundle", () => {
    it("returns empty bundle when no attestations exist", () => {
      const json = service.generateAttestedReportsBundle();
      const parsed = JSON.parse(json);
      expect(parsed.reports).toEqual([]);
      expect(parsed.count).toBe(0);
    });

    it("includes only attested snapshots in bundle", async () => {
      const s1 = await service.createSnapshot(false, new Date("2026-01-01"));
      await service.createSnapshot(false, new Date("2026-04-01"));

      await service.createAttestation(s1.snapshotId, "reviewer-alice", "approved");

      const json = service.generateAttestedReportsBundle();
      const parsed = JSON.parse(json);
      expect(parsed.count).toBe(1);
      expect(parsed.reports[0].quarterLabel).toBe("2026-Q1");
    });
  });

  // ── Test Helpers ─────────────────────────────────────────────────────────

  describe("injectSnapshot / injectAttestation", () => {
    it("injects a snapshot for testing", () => {
      const snapshot = createTestSnapshot();
      service.injectSnapshot(snapshot);

      expect(service.getSnapshot("test-snapshot-1")).toBeTruthy();
    });

    it("injects an attestation for testing", () => {
      const snapshot = createTestSnapshot();
      service.injectSnapshot(snapshot);

      const attestation = createTestAttestation();
      service.injectAttestation(attestation);

      const retrieved = service.getAttestation("test-att-1");
      expect(retrieved).toBeTruthy();
      expect(retrieved!.reviewer).toBe("reviewer-alice");
    });

    it("clear resets all data", () => {
      service.injectSnapshot(createTestSnapshot());
      service.injectAttestation(createTestAttestation());

      service.clear();

      expect(service.listSnapshots().total).toBe(0);
      expect(service.listAttestations().total).toBe(0);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles reviewer absent: snapshot without attestation is valid but unreviewed", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      expect(service.getSnapshot(snapshot.snapshotId)).toBeTruthy();

      const report = service.generateReport(snapshot.snapshotId);
      expect(report.reviewed).toBe(false);
    });

    it("handles mid-quarter role change with forced snapshot", async () => {
      const s1 = await service.createSnapshot(false, new Date("2026-05-01"));
      const s2 = await service.createSnapshot(true, new Date("2026-06-15"));

      expect(s1.snapshotId).not.toBe(s2.snapshotId);
      expect(s1.quarterLabel).toBe("2026-Q2");
      expect(s2.quarterLabel).toBe("2026-Q2");

      const result = service.listSnapshots({ quarterLabel: "2026-Q2" });
      expect(result.total).toBe(2);
    });

    it("handles snapshot gap detection", async () => {
      await service.createSnapshot(false, new Date("2026-01-01"));
      await service.createSnapshot(false, new Date("2026-07-01"));

      const gaps = service.detectGaps(4);
      expect(gaps).toHaveProperty("hasGap");
      expect(gaps).toHaveProperty("missingQuarters");
    });

    it("handles snapshot with default role config", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      expect(snapshot.grants.length).toBeGreaterThan(0);
    });

    it("handles attestation with long notes", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));
      const longNotes = "x".repeat(1000);

      const att = await service.createAttestation(
        snapshot.snapshotId,
        "reviewer-alice",
        "approved",
        longNotes,
      );

      expect(att.notes).toBe(longNotes);
    });

    it("handles CSV escaping with special characters in notes", async () => {
      const snapshot = await service.createSnapshot(false, new Date("2026-05-01"));

      await service.createAttestation(
        snapshot.snapshotId,
        "reviewer-alice",
        "approved",
        'Notes with, commas and "quotes"',
      );

      const csv = service.generateFormattedReport(snapshot.snapshotId, "csv");
      expect(csv).toContain("Notes with,");
    });
  });
});

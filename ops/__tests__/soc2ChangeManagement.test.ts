import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  AuditLedgerStore,
  defaultGitHubPrFetcher,
  emitOverrideAlarm,
  verifyDeployPr,
  DeployAuditRecord,
} from "../soc2ChangeManagement.js";

describe("SOC2 Change Management - AuditLedgerStore", () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soc2-test-"));
    ledgerPath = path.join(tempDir, "sub", "deploy-audit-ledger.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty array if file does not exist", () => {
    const store = new AuditLedgerStore(ledgerPath);
    expect(store.loadLedger()).toEqual([]);
    expect(store.getLedgerPath()).toBe(ledgerPath);
  });

  it("uses default ledgerPath if omitted in constructor", () => {
    const store = new AuditLedgerStore();
    expect(store.getLedgerPath()).toContain("deploy-audit-ledger.json");
  });

  it("creates directory and writes records to file on save", () => {
    const store = new AuditLedgerStore(ledgerPath);
    const sampleRecord: DeployAuditRecord = {
      deployId: "dep_101",
      commitHash: "abc1234",
      prNumber: 42,
      prTitle: "Feature PR",
      prUrl: "https://github.com/org/repo/pull/42",
      environment: "production",
      status: "APPROVED",
      timestamp: "2026-07-28T12:00:00.000Z",
      override: false,
      overrideReason: null,
      deployType: "STANDARD",
      actor: "test-user",
      gitRef: "refs/heads/main",
    };

    store.saveLedger([sampleRecord]);
    expect(fs.existsSync(ledgerPath)).toBe(true);

    const loaded = store.loadLedger();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].deployId).toBe("dep_101");
  });

  it("appends records correctly", () => {
    const store = new AuditLedgerStore(ledgerPath);
    const record1: DeployAuditRecord = {
      deployId: "dep_1",
      commitHash: "c1",
      prNumber: 1,
      prTitle: "PR 1",
      prUrl: null,
      environment: "staging",
      status: "APPROVED",
      timestamp: "2026-07-28T10:00:00.000Z",
      override: false,
      overrideReason: null,
      deployType: "STANDARD",
      actor: "user1",
      gitRef: null,
    };
    const record2: DeployAuditRecord = {
      deployId: "dep_2",
      commitHash: "c2",
      prNumber: 2,
      prTitle: "PR 2",
      prUrl: null,
      environment: "production",
      status: "APPROVED",
      timestamp: "2026-07-28T11:00:00.000Z",
      override: false,
      overrideReason: null,
      deployType: "STANDARD",
      actor: "user2",
      gitRef: null,
    };

    store.appendRecord(record1);
    store.appendRecord(record2);

    expect(store.getAllRecords()).toHaveLength(2);
    expect(store.findRecordByCommit("c1")?.deployId).toBe("dep_1");
    expect(store.findRecordByDeployId("dep_2")?.commitHash).toBe("c2");
    expect(store.findRecordByCommit("nonexistent")).toBeUndefined();
  });

  it("handles corrupted or empty JSON ledger file gracefully", () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, "invalid json syntax", "utf8");

    const store = new AuditLedgerStore(ledgerPath);
    expect(store.loadLedger()).toEqual([]);

    fs.writeFileSync(ledgerPath, "", "utf8");
    expect(store.loadLedger()).toEqual([]);
  });
});

describe("SOC2 Change Management - Alarm Emission", () => {
  it("emits alarm string to process.stderr", () => {
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);

    const record: DeployAuditRecord = {
      deployId: "dep_999",
      commitHash: "deadbeef",
      prNumber: null,
      prTitle: null,
      prUrl: null,
      environment: "production",
      status: "OVERRIDDEN",
      timestamp: "2026-07-28T12:00:00.000Z",
      override: true,
      overrideReason: "Emergency hotfix for outage",
      deployType: "HOTFIX",
      actor: "admin",
      gitRef: "refs/heads/hotfix",
    };

    const msg = emitOverrideAlarm(record, "Emergency hotfix for outage");
    expect(msg).toContain("[SOC2_ALARM]");
    expect(msg).toContain("dep_999");
    expect(msg).toContain("Emergency hotfix for outage");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[SOC2_ALARM]"));

    stderrSpy.mockRestore();
  });
});

describe("SOC2 Change Management - defaultGitHubPrFetcher", () => {
  let originalFetch: typeof globalThis.fetch;
  const oldToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (oldToken !== undefined) {
      process.env.GITHUB_TOKEN = oldToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("returns null if token or repo is missing", async () => {
    delete process.env.GITHUB_TOKEN;
    const result = await defaultGitHubPrFetcher(123, "", undefined);
    expect(result).toBeNull();
  });

  it("fetches PR details via GitHub API successfully using env token", async () => {
    process.env.GITHUB_TOKEN = "env_token";
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 520,
        title: "SOC2 Guardrails",
        merged: true,
        html_url: "https://github.com/Chronopay-Org/ChronoPay-Backend/pull/520",
        merged_at: "2026-07-28T10:00:00Z",
        head: { ref: "feat/soc2-change-mgmt" },
        base: { ref: "main" },
      }),
    } as Response);

    const res = await defaultGitHubPrFetcher(520, "Chronopay-Org/ChronoPay-Backend");
    expect(res).not.toBeNull();
    expect(res?.number).toBe(520);
    expect(res?.merged).toBe(true);
    expect(res?.title).toBe("SOC2 Guardrails");
  });

  it("returns null if API request fails or returns non-ok", async () => {
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const res = await defaultGitHubPrFetcher(999, "Chronopay-Org/ChronoPay-Backend", "token_abc");
    expect(res).toBeNull();
  });

  it("returns null if fetch throws network error", async () => {
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Network error"));

    const res = await defaultGitHubPrFetcher(999, "Chronopay-Org/ChronoPay-Backend", "token_abc");
    expect(res).toBeNull();
  });
});

describe("SOC2 Change Management - verifyDeployPr core function", () => {
  let tempDir: string;
  let ledgerPath: string;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soc2-verify-test-"));
    ledgerPath = path.join(tempDir, "deploy-audit-ledger.json");
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws error if commitHash is missing", async () => {
    await expect(verifyDeployPr({ commitHash: "" })).rejects.toThrow("commitHash is required");
  });

  it("approves standard deploy when merged PR is supplied", async () => {
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 100,
      title: "Add feature",
      merged: true,
    });

    const res = await verifyDeployPr({
      commitHash: "hash123",
      prNumber: 100,
      ledgerPath,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(true);
    expect(res.overridden).toBe(false);
    expect(res.status).toBe("APPROVED");
    expect(res.reason).toContain("Deploy verified and linked to merged PR #100");
    expect(res.record.prTitle).toBe("Add feature");

    const store = new AuditLedgerStore(ledgerPath);
    expect(store.getAllRecords()).toHaveLength(1);
  });

  it("blocks standard deploy when PR is unmerged", async () => {
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 101,
      title: "WIP feature",
      merged: false,
    });

    const res = await verifyDeployPr({
      commitHash: "hash456",
      prNumber: 101,
      ledgerPath,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(false);
    expect(res.status).toBe("BLOCKED");
    expect(res.reason).toContain("PR #101 is not merged");
  });

  it("blocks standard deploy when no PR number or commitPrDetector matches", async () => {
    const res = await verifyDeployPr({
      commitHash: "hash789",
      ledgerPath,
      prFetcher: async () => null,
    });

    expect(res.approved).toBe(false);
    expect(res.status).toBe("BLOCKED");
    expect(res.reason).toContain("No merged PR found for deploy commit");
  });

  it("uses commitPrDetector to find merged PR when prNumber is omitted", async () => {
    const mockDetector = jest.fn<any>().mockResolvedValue({ prNumber: 200, prTitle: "Auto PR" });
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 200,
      title: "Auto PR",
      merged: true,
    });

    const res = await verifyDeployPr({
      commitHash: "hash200",
      ledgerPath,
      commitPrDetector: mockDetector,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(true);
    expect(res.record.prNumber).toBe(200);
    expect(res.record.prTitle).toBe("Auto PR");
  });

  it("uses commitPrDetector without title and resolves title from prFetcher", async () => {
    const mockDetector = jest.fn<any>().mockResolvedValue({ prNumber: 205 });
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 205,
      title: "Fetched Title",
      merged: true,
    });

    const res = await verifyDeployPr({
      commitHash: "hash205",
      ledgerPath,
      commitPrDetector: mockDetector,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(true);
    expect(res.record.prTitle).toBe("Fetched Title");
  });

  it("handles commitPrDetector returning null", async () => {
    const mockDetector = jest.fn<any>().mockResolvedValue(null);

    const res = await verifyDeployPr({
      commitHash: "hashNullDetector",
      ledgerPath,
      commitPrDetector: mockDetector,
    });

    expect(res.approved).toBe(false);
    expect(res.status).toBe("BLOCKED");
  });

  it("handles manual override with reason and emits alarm", async () => {
    const res = await verifyDeployPr({
      commitHash: "override123",
      override: true,
      overrideReason: "Critical security patch bypass",
      ledgerPath,
    });

    expect(res.approved).toBe(true);
    expect(res.overridden).toBe(true);
    expect(res.status).toBe("OVERRIDDEN");
    expect(res.alarmEmitted).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("[SOC2_ALARM]"));
  });

  it("throws error if manual override is requested without a reason", async () => {
    await expect(
      verifyDeployPr({
        commitHash: "override456",
        override: true,
        overrideReason: "   ",
        ledgerPath,
      })
    ).rejects.toThrow("Override requires a non-empty override reason");
  });

  it("handles Rollback deploy edge case - prior approved deploy record", async () => {
    const store = new AuditLedgerStore(ledgerPath);
    store.appendRecord({
      deployId: "dep_prior",
      commitHash: "rollback_commit",
      prNumber: 50,
      prTitle: "Original PR",
      prUrl: null,
      environment: "production",
      status: "APPROVED",
      timestamp: "2026-07-27T00:00:00.000Z",
      override: false,
      overrideReason: null,
      deployType: "STANDARD",
      actor: "dev",
      gitRef: null,
    });

    const res = await verifyDeployPr({
      commitHash: "rollback_commit",
      deployType: "ROLLBACK",
      ledgerPath,
    });

    expect(res.approved).toBe(true);
    expect(res.status).toBe("APPROVED");
    expect(res.record.deployType).toBe("ROLLBACK");
    expect(res.reason).toContain("Rollback deployment verified against prior approved deploy or merged PR");
  });

  it("handles Rollback deploy edge case - merged rollback PR", async () => {
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 55,
      title: "Revert broken change",
      merged: true,
    });

    const res = await verifyDeployPr({
      commitHash: "rollback_commit_2",
      prNumber: 55,
      deployType: "ROLLBACK",
      ledgerPath,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(true);
    expect(res.record.prNumber).toBe(55);
  });

  it("blocks Rollback deploy edge case when target commit lacks prior record or PR", async () => {
    const res = await verifyDeployPr({
      commitHash: "unknown_rollback_commit",
      deployType: "ROLLBACK",
      ledgerPath,
    });

    expect(res.approved).toBe(false);
    expect(res.status).toBe("BLOCKED");
    expect(res.reason).toContain("Rollback target commit lacks merged PR or prior deployment audit record");
  });

  it("handles Tag Re-deploy edge case - prior approved record", async () => {
    const store = new AuditLedgerStore(ledgerPath);
    store.appendRecord({
      deployId: "dep_tag_1",
      commitHash: "tag_commit_hash",
      prNumber: 60,
      prTitle: "Tag release PR",
      prUrl: null,
      environment: "production",
      status: "APPROVED",
      timestamp: "2026-07-28T08:00:00.000Z",
      override: false,
      overrideReason: null,
      deployType: "STANDARD",
      actor: "ci",
      gitRef: "refs/tags/v1.0.0",
    });

    const res = await verifyDeployPr({
      commitHash: "tag_commit_hash",
      deployType: "TAG_REDEPLOY",
      ledgerPath,
    });

    expect(res.approved).toBe(true);
    expect(res.record.deployType).toBe("TAG_REDEPLOY");
  });

  it("handles Tag Re-deploy edge case - merged PR fetcher", async () => {
    const mockFetcher = jest.fn<any>().mockResolvedValue({
      number: 70,
      title: "Tag PR",
      merged: true,
    });

    const res = await verifyDeployPr({
      commitHash: "tag_commit_hash_2",
      prNumber: 70,
      deployType: "TAG_REDEPLOY",
      ledgerPath,
      prFetcher: mockFetcher,
    });

    expect(res.approved).toBe(true);
    expect(res.record.prNumber).toBe(70);
  });

  it("blocks Tag Re-deploy edge case when tag commit has no prior record or PR", async () => {
    const res = await verifyDeployPr({
      commitHash: "unverified_tag_commit",
      deployType: "TAG_REDEPLOY",
      ledgerPath,
    });

    expect(res.approved).toBe(false);
    expect(res.status).toBe("BLOCKED");
    expect(res.reason).toContain("Tag re-deploy commit lacks merged PR or prior deployment audit record");
  });
});

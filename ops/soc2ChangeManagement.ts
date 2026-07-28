import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";

export type DeployStatus = "APPROVED" | "BLOCKED" | "OVERRIDDEN";
export type DeployType = "STANDARD" | "ROLLBACK" | "HOTFIX" | "TAG_REDEPLOY";

export interface DeployAuditRecord {
  deployId: string;
  commitHash: string;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  environment: string;
  status: DeployStatus;
  timestamp: string;
  override: boolean;
  overrideReason: string | null;
  deployType: DeployType;
  actor: string;
  gitRef: string | null;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  merged: boolean;
  url?: string;
  mergedAt?: string | null;
  headRef?: string;
  baseRef?: string;
}

export interface VerifyDeployPrOptions {
  commitHash: string;
  prNumber?: number;
  environment?: string;
  deployType?: DeployType;
  override?: boolean;
  overrideReason?: string;
  ledgerPath?: string;
  githubToken?: string;
  githubRepo?: string;
  gitRef?: string;
  actor?: string;
  prFetcher?: (prNumber: number, repo: string, token?: string) => Promise<PullRequestInfo | null>;
  commitPrDetector?: (commitHash: string) => Promise<{ prNumber: number; prTitle?: string } | null>;
}

export interface VerifyDeployPrResult {
  approved: boolean;
  overridden: boolean;
  status: DeployStatus;
  reason: string;
  record: DeployAuditRecord;
  alarmEmitted?: boolean;
}

/**
 * Manages storage and retrieval of deploy-to-PR audit records in JSON format.
 */
export class AuditLedgerStore {
  private ledgerPath: string;

  constructor(ledgerPath: string = path.resolve(process.cwd(), "ops/deploy-audit-ledger.json")) {
    this.ledgerPath = ledgerPath;
  }

  public getLedgerPath(): string {
    return this.ledgerPath;
  }

  public loadLedger(): DeployAuditRecord[] {
    if (!fs.existsSync(this.ledgerPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      if (!raw.trim()) {
        return [];
      }
      return JSON.parse(raw) as DeployAuditRecord[];
    } catch {
      return [];
    }
  }

  public saveLedger(records: DeployAuditRecord[]): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.ledgerPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  public appendRecord(record: DeployAuditRecord): void {
    const records = this.loadLedger();
    records.push(record);
    this.saveLedger(records);
  }

  public findRecordByCommit(commitHash: string): DeployAuditRecord | undefined {
    const records = this.loadLedger();
    return records.slice().reverse().find((r) => r.commitHash === commitHash);
  }

  public findRecordByDeployId(deployId: string): DeployAuditRecord | undefined {
    const records = this.loadLedger();
    return records.find((r) => r.deployId === deployId);
  }

  public getAllRecords(): DeployAuditRecord[] {
    return this.loadLedger();
  }
}

/**
 * Emits a high-priority SOC2 compliance alarm to stderr when a manual deploy override occurs.
 */
export function emitOverrideAlarm(record: DeployAuditRecord, reason: string): string {
  const alarmMessage = `[SOC2_ALARM] MANUAL DEPLOY OVERRIDE DETECTED: Deploy ${record.deployId} (commit ${record.commitHash}) in environment '${record.environment}' overridden by '${record.actor}'. Reason: ${reason}`;
  process.stderr.write(`${alarmMessage}\n`);
  return alarmMessage;
}

/**
 * Default PR fetcher that uses GitHub REST API if GITHUB_TOKEN is available.
 */
export async function defaultGitHubPrFetcher(
  prNumber: number,
  repo: string,
  token?: string
): Promise<PullRequestInfo | null> {
  const authToken = token || process.env.GITHUB_TOKEN;
  if (!authToken || !repo) {
    return null;
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "SOC2-Change-Management-Guardrail",
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${authToken}`,
    };

    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers });
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      number: number;
      title: string;
      merged?: boolean;
      html_url?: string;
      merged_at?: string | null;
      head?: { ref?: string };
      base?: { ref?: string };
    };

    return {
      number: data.number,
      title: data.title,
      merged: Boolean(data.merged || data.merged_at),
      url: data.html_url,
      mergedAt: data.merged_at,
      headRef: data.head?.ref,
      baseRef: data.base?.ref,
    };
  } catch {
    return null;
  }
}

/**
 * Core pre-deploy verification function linking deploys to merged PRs.
 */
export async function verifyDeployPr(options: VerifyDeployPrOptions): Promise<VerifyDeployPrResult> {
  const commitHash = options.commitHash?.trim();
  if (!commitHash) {
    throw new Error("commitHash is required for SOC2 change-management verification");
  }

  const environment = options.environment || process.env.DEPLOY_ENV || "production";
  const deployType: DeployType = options.deployType || "STANDARD";
  const override = Boolean(options.override);
  const overrideReason = options.overrideReason?.trim() || null;
  const ledgerPath = options.ledgerPath || process.env.AUDIT_LEDGER_PATH || path.resolve(process.cwd(), "ops/deploy-audit-ledger.json");
  const githubRepo = options.githubRepo || process.env.GITHUB_REPOSITORY || "Chronopay-Org/ChronoPay-Backend";
  const githubToken = options.githubToken || process.env.GITHUB_TOKEN;
  const gitRef = options.gitRef || process.env.GITHUB_REF || null;
  const actor = options.actor || process.env.GITHUB_ACTOR || process.env.USER || process.env.USERNAME || "system";

  const store = new AuditLedgerStore(ledgerPath);
  const deployId = `dep_${Date.now()}_${uuidv4().slice(0, 8)}`;

  // Handle Manual Override
  if (override) {
    if (!overrideReason) {
      throw new Error("Override requires a non-empty override reason");
    }

    const record: DeployAuditRecord = {
      deployId,
      commitHash,
      prNumber: options.prNumber || null,
      prTitle: null,
      prUrl: null,
      environment,
      status: "OVERRIDDEN",
      timestamp: new Date().toISOString(),
      override: true,
      overrideReason,
      deployType,
      actor,
      gitRef,
    };

    store.appendRecord(record);
    const alarmMessage = emitOverrideAlarm(record, overrideReason);

    return {
      approved: true,
      overridden: true,
      status: "OVERRIDDEN",
      reason: `Deploy approved via manual override: ${overrideReason}`,
      record,
      alarmEmitted: true,
    };
  }

  // Handle Edge Case: Rollback Deploys
  if (deployType === "ROLLBACK") {
    const existingRecord = store.findRecordByCommit(commitHash);
    let rollbackApproved = false;
    let rollbackPrNumber: number | null = options.prNumber || null;
    let rollbackPrTitle: string | null = null;

    if (existingRecord && (existingRecord.status === "APPROVED" || existingRecord.status === "OVERRIDDEN")) {
      rollbackApproved = true;
      rollbackPrNumber = existingRecord.prNumber;
      rollbackPrTitle = existingRecord.prTitle;
    } else if (options.prNumber) {
      const prFetcher = options.prFetcher || defaultGitHubPrFetcher;
      const prInfo = await prFetcher(options.prNumber, githubRepo, githubToken);
      if (prInfo && prInfo.merged) {
        rollbackApproved = true;
        rollbackPrTitle = prInfo.title;
      }
    }

    const record: DeployAuditRecord = {
      deployId,
      commitHash,
      prNumber: rollbackPrNumber,
      prTitle: rollbackPrTitle,
      prUrl: rollbackPrNumber ? `https://github.com/${githubRepo}/pull/${rollbackPrNumber}` : null,
      environment,
      status: rollbackApproved ? "APPROVED" : "BLOCKED",
      timestamp: new Date().toISOString(),
      override: false,
      overrideReason: null,
      deployType: "ROLLBACK",
      actor,
      gitRef,
    };

    store.appendRecord(record);

    if (rollbackApproved) {
      return {
        approved: true,
        overridden: false,
        status: "APPROVED",
        reason: "Rollback deployment verified against prior approved deploy or merged PR",
        record,
      };
    }

    return {
      approved: false,
      overridden: false,
      status: "BLOCKED",
      reason: "Rollback target commit lacks merged PR or prior deployment audit record",
      record,
    };
  }

  // Handle Edge Case: Tag Re-deploying
  if (deployType === "TAG_REDEPLOY") {
    const existingRecord = store.findRecordByCommit(commitHash);
    let tagApproved = false;
    let tagPrNumber: number | null = options.prNumber || null;
    let tagPrTitle: string | null = null;

    if (existingRecord && (existingRecord.status === "APPROVED" || existingRecord.status === "OVERRIDDEN")) {
      tagApproved = true;
      tagPrNumber = existingRecord.prNumber;
      tagPrTitle = existingRecord.prTitle;
    } else if (options.prNumber) {
      const prFetcher = options.prFetcher || defaultGitHubPrFetcher;
      const prInfo = await prFetcher(options.prNumber, githubRepo, githubToken);
      if (prInfo && prInfo.merged) {
        tagApproved = true;
        tagPrTitle = prInfo.title;
      }
    }

    const record: DeployAuditRecord = {
      deployId,
      commitHash,
      prNumber: tagPrNumber,
      prTitle: tagPrTitle,
      prUrl: tagPrNumber ? `https://github.com/${githubRepo}/pull/${tagPrNumber}` : null,
      environment,
      status: tagApproved ? "APPROVED" : "BLOCKED",
      timestamp: new Date().toISOString(),
      override: false,
      overrideReason: null,
      deployType: "TAG_REDEPLOY",
      actor,
      gitRef,
    };

    store.appendRecord(record);

    if (tagApproved) {
      return {
        approved: true,
        overridden: false,
        status: "APPROVED",
        reason: "Tag re-deploy verified against prior approved deploy or merged PR",
        record,
      };
    }

    return {
      approved: false,
      overridden: false,
      status: "BLOCKED",
      reason: "Tag re-deploy commit lacks merged PR or prior deployment audit record",
      record,
    };
  }

  // Handle Standard / Hotfix Deploys: Resolve PR
  let resolvedPrNumber: number | null = options.prNumber || null;
  let resolvedPrTitle: string | null = null;
  let isMerged = false;

  const prFetcher = options.prFetcher || defaultGitHubPrFetcher;

  if (resolvedPrNumber) {
    const prInfo = await prFetcher(resolvedPrNumber, githubRepo, githubToken);
    if (prInfo) {
      isMerged = prInfo.merged;
      resolvedPrTitle = prInfo.title;
    }
  } else if (options.commitPrDetector) {
    const detected = await options.commitPrDetector(commitHash);
    if (detected && detected.prNumber) {
      resolvedPrNumber = detected.prNumber;
      resolvedPrTitle = detected.prTitle || null;
      const prInfo = await prFetcher(resolvedPrNumber, githubRepo, githubToken);
      if (prInfo) {
        isMerged = prInfo.merged;
        if (!resolvedPrTitle) {
          resolvedPrTitle = prInfo.title;
        }
      }
    }
  }

  const isApproved = isMerged;
  const status: DeployStatus = isApproved ? "APPROVED" : "BLOCKED";

  const record: DeployAuditRecord = {
    deployId,
    commitHash,
    prNumber: resolvedPrNumber,
    prTitle: resolvedPrTitle,
    prUrl: resolvedPrNumber ? `https://github.com/${githubRepo}/pull/${resolvedPrNumber}` : null,
    environment,
    status,
    timestamp: new Date().toISOString(),
    override: false,
    overrideReason: null,
    deployType,
    actor,
    gitRef,
  };

  store.appendRecord(record);

  if (isApproved) {
    return {
      approved: true,
      overridden: false,
      status: "APPROVED",
      reason: `Deploy verified and linked to merged PR #${resolvedPrNumber}`,
      record,
    };
  }

  return {
    approved: false,
    overridden: false,
    status: "BLOCKED",
    reason: resolvedPrNumber
      ? `PR #${resolvedPrNumber} is not merged`
      : "No merged PR found for deploy commit",
    record,
  };
}

import * as fs from "node:fs";
import * as path from "node:path";

export interface PullRequestLookupResponse {
  number?: number;
  state?: string | null;
  merged_at?: string | null;
  html_url?: string;
}

export interface DeployPrGuardInput {
  deployId: string;
  repo: string;
  prNumber: number;
  sha: string;
  manualOverride?: boolean;
  ledgerPath?: string;
  fetchJson?: (url: string) => Promise<PullRequestLookupResponse>;
}

export interface DeployPrGuardResult {
  deployId: string;
  repo: string;
  prNumber: number;
  sha: string;
  status: "approved" | "rejected";
  mergedAt?: string;
  manualOverride: boolean;
}

export interface AuditEntry {
  timestamp: string;
  deployId: string;
  repo: string;
  prNumber: number;
  sha: string;
  event: "deploy_approved" | "deploy_rejected" | "manual_override_alarm";
  status: "approved" | "rejected";
  manualOverride: boolean;
  mergedAt?: string;
}

export function isMergedPrResponse(value: Partial<PullRequestLookupResponse> | null | undefined): boolean {
  if (!value) return false;
  const state = value.state ?? "";
  const mergedAt = value.merged_at ?? null;
  return state.toLowerCase() === "closed" && typeof mergedAt === "string" && mergedAt.length > 0;
}

export function createAuditEntry(input: {
  deployId: string;
  repo: string;
  prNumber: number;
  sha: string;
  event: AuditEntry["event"];
  status: AuditEntry["status"];
  manualOverride?: boolean;
  mergedAt?: string;
}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    deployId: input.deployId,
    repo: input.repo,
    prNumber: input.prNumber,
    sha: input.sha,
    event: input.event,
    status: input.status,
    manualOverride: Boolean(input.manualOverride),
    mergedAt: input.mergedAt,
  };
}

export function appendAuditEntry(ledgerPath: string, entry: AuditEntry): void {
  const dir = path.dirname(ledgerPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
}

export async function validateDeployPrRecord(input: DeployPrGuardInput): Promise<DeployPrGuardResult> {
  const ledgerPath = input.ledgerPath ?? path.join(process.cwd(), ".deploy-pr-ledger.jsonl");
  const fetchJson =
    input.fetchJson ??
    (async (url: string) => {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        throw new Error(`Failed to fetch PR record: ${response.status}`);
      }
      return (await response.json()) as PullRequestLookupResponse;
    });

  if (input.manualOverride) {
    const alarm = createAuditEntry({
      deployId: input.deployId,
      repo: input.repo,
      prNumber: input.prNumber,
      sha: input.sha,
      event: "manual_override_alarm",
      status: "rejected",
      manualOverride: true,
    });
    appendAuditEntry(ledgerPath, alarm);
    throw new Error("Manual override detected: production deploy is blocked until a merged PR is recorded.");
  }

  const prUrl = `https://api.github.com/repos/${input.repo}/pulls/${input.prNumber}`;
  const pr = await fetchJson(prUrl);
  const mergedAt = pr.merged_at ?? undefined;

  if (!isMergedPrResponse(pr)) {
    const rejected = createAuditEntry({
      deployId: input.deployId,
      repo: input.repo,
      prNumber: input.prNumber,
      sha: input.sha,
      event: "deploy_rejected",
      status: "rejected",
      manualOverride: false,
      mergedAt,
    });
    appendAuditEntry(ledgerPath, rejected);
    throw new Error(`Deploy ${input.deployId} is blocked: PR #${input.prNumber} must be merged before production deploy.`);
  }

  const approved = createAuditEntry({
    deployId: input.deployId,
    repo: input.repo,
    prNumber: input.prNumber,
    sha: input.sha,
    event: "deploy_approved",
    status: "approved",
    manualOverride: false,
    mergedAt,
  });
  appendAuditEntry(ledgerPath, approved);

  return {
    deployId: input.deployId,
    repo: input.repo,
    prNumber: input.prNumber,
    sha: input.sha,
    status: "approved",
    mergedAt,
    manualOverride: false,
  };
}

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("deploy-pr-guard.ts")) {
  const required = ["DEPLOY_ID", "REPO", "PR_NUMBER", "SHA"] as const;
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const prNumber = Number(process.env.PR_NUMBER);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("PR_NUMBER must be a positive integer.");
    process.exit(1);
  }

  validateDeployPrRecord({
    deployId: process.env.DEPLOY_ID!,
    repo: process.env.REPO!,
    prNumber,
    sha: process.env.SHA!,
    manualOverride: process.env.MANUAL_OVERRIDE === "true",
  }).then(() => {
    console.log(`Deploy ${process.env.DEPLOY_ID} approved for merged PR #${prNumber}.`);
  }).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}

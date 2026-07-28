/**
 * dashboard-preview-bot.ts
 *
 * PR-comment bot that renders dashboard JSON diffs for reviewers.
 * Computes the diff between dashboard JSON files in the PR branch and the
 * base branch, then outputs a formatted comment body.
 *
 * Suppresses output on fork PRs to avoid leaking internal dashboards.
 *
 * Usage:
 *   BASE_REF=origin/main \
 *   HEAD_SHA=$(git rev-parse HEAD) \
 *   GITHUB_REPOSITORY=owner/repo \
 *   GITHUB_EVENT_NAME=pull_request \
 *   GITHUB_PR_NUMBER=123 \
 *   npx tsx scripts/dashboard-preview-bot.ts
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardFile {
  name: string;
  path: string;
  uid: string;
  title: string;
  panelCount: number;
}

export interface DashboardDiff {
  file: string;
  title: string;
  uid: string;
  status: "added" | "removed" | "modified";
  summary: string;
  diffLines: string[];
}

export interface PreviewComment {
  body: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reads a dashboard JSON file and extracts metadata.
 */
export function readDashboardMeta(filePath: string): DashboardFile | null {
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      name: path.basename(filePath, ".json"),
      path: filePath,
      uid: content.uid || "unknown",
      title: content.title || "Untitled",
      panelCount: Array.isArray(content.panels) ? content.panels.length : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the list of dashboard JSON files in a given directory.
 */
export function findDashboardFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .filter((fp) => {
        const meta = readDashboardMeta(fp);
        return meta !== null;
      });
  } catch {
    return [];
  }
}

/**
 * Generates a human-readable summary of a dashboard diff.
 */
export function summarizeDiff(
  base: DashboardFile | null,
  head: DashboardFile | null,
): string {
  if (!base && head) return `${head.title} (${head.panelCount} panels) — ADDED`;
  if (base && !head) return `${base.title} (${base.panelCount} panels) — REMOVED`;
  if (!base && !head) return "Unknown";

  const changes: string[] = [];
  if (base!.title !== head!.title) changes.push("title changed");
  if (base!.panelCount !== head!.panelCount)
    changes.push(`${base!.panelCount} → ${head!.panelCount} panels`);

  return changes.length > 0
    ? `${head!.title} — ${changes.join(", ")}`
    : `${head!.title} — no structural changes`;
}

/**
 * Computes the JSON diff between two dashboard files using git diff.
 */
export function getDashboardDiff(
  baseRef: string,
  headSha: string,
  relativePath: string,
): { diffLines: string[]; rawDiff: string } {
  try {
    const rawDiff = execSync(
      `git diff ${baseRef}...${headSha} -- "${relativePath}"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const lines = rawDiff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    return { diffLines: lines, rawDiff };
  } catch {
    return { diffLines: [], rawDiff: "" };
  }
}

/**
 * Finds all dashboard JSON files that changed between two refs using git diff.
 */
export function findChangedDashboards(
  baseRef: string,
  headSha: string,
  dashboardDir: string,
): string[] {
  try {
    const output = execSync(
      `git diff --name-only ${baseRef}...${headSha} -- "${dashboardDir}/*.json"`,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.endsWith(".json"));
  } catch {
    return [];
  }
}

// ─── Is Fork Check ───────────────────────────────────────────────────────────

/**
 * Checks whether the current PR is from a fork. The GITHUB_EVENT_NAME and
 * GITHUB_REPOSITORY environment variables are used for detection.
 *
 * When the event is pull_request_target or the base repo is the canonical
 * repo, we can safely render dashboards. Forks get a suppressed message.
 */
export function isForkPr(): boolean {
  // In Actions, pull_request events from forks have GITHUB_REF_NAME set to
  // the merge branch, and GITHUB_REPOSITORY is always the base repo.
  // We detect forks by checking if the head repo differs from base.
  const headRepo = process.env.HEAD_REPO || "";
  const baseRepo = process.env.GITHUB_REPOSITORY || "";
  return headRepo !== "" && headRepo !== baseRepo;
}

// ─── Comment Builder ─────────────────────────────────────────────────────────

/**
 * Builds a PR comment body with dashboard diffs.
 */
export function buildPreviewComment(diffs: DashboardDiff[], isFork: boolean): PreviewComment {
  const lines: string[] = [];

  if (isFork) {
    lines.push("## 🖼️ Dashboard Preview");
    lines.push("");
    lines.push(
      "⛔ Dashboard preview is suppressed for fork PRs to avoid leaking internal dashboards.",
    );
    lines.push("");
    lines.push("Reviewers: check out the branch locally and run:");
    lines.push("```bash");
    lines.push("npx tsx scripts/validate-dashboards.ts");
    lines.push("```");
    return { body: lines.join("\n") };
  }

  if (diffs.length === 0) {
    lines.push("## 🖼️ Dashboard Preview");
    lines.push("");
    lines.push("✅ No dashboard changes detected.");
    return { body: lines.join("\n") };
  }

  lines.push("## 🖼️ Dashboard Preview");
  lines.push("");
  lines.push(`Found **${diffs.length}** dashboard file(s) with changes:\n`);

  for (const diff of diffs) {
    lines.push(`### ${diff.title} (\`${diff.file}\`)`);
    lines.push(`**Status:** ${diff.status}`);
    lines.push(`**Summary:** ${diff.summary}`);

    if (diff.diffLines.length > 0) {
      lines.push("");
      lines.push("<details>");
      lines.push("<summary>📝 JSON Diff</summary>");
      lines.push("");
      lines.push("```diff");
      // Limit diff output to prevent excessively large comments
      const maxLines = 200;
      const shown = diff.diffLines.slice(0, maxLines);
      lines.push(...shown);
      if (diff.diffLines.length > maxLines) {
        lines.push(`... (+${diff.diffLines.length - maxLines} more lines)`);
      }
      lines.push("```");
      lines.push("</details>");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Generated by [dashboard-preview-bot](https://github.com/Chronopay-Org/ChronoPay-Backend/actions)._",
  );

  return { body: lines.join("\n") };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runDashboardPreview(): Promise<PreviewComment> {
  const baseRef = process.env.BASE_REF || "origin/main";
  const headSha = process.env.HEAD_SHA || "HEAD";
  const dashboardDir = process.env.DASHBOARD_DIR || "ops/dashboards";

  const fork = isForkPr();
  const changedFiles = findChangedDashboards(baseRef, headSha, dashboardDir);

  const diffs: DashboardDiff[] = [];

  for (const filePath of changedFiles) {
    const absPath = path.resolve(filePath);
    const headMeta = readDashboardMeta(absPath);
    if (!headMeta) continue;

    let baseMeta: DashboardFile | null = null;
    try {
      // Read the base version of the file from git
      const baseContent = execSync(
        `git show ${baseRef}:${filePath}`,
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      );
      baseMeta = {
        name: headMeta.name,
        path: filePath,
        uid: JSON.parse(baseContent).uid || "unknown",
        title: JSON.parse(baseContent).title || "Untitled",
        panelCount: Array.isArray(JSON.parse(baseContent).panels)
          ? JSON.parse(baseContent).panels.length
          : 0,
      };
    } catch {
      // File doesn't exist in base — it's newly added
      baseMeta = null;
    }

    const status: DashboardDiff["status"] = !baseMeta
      ? "added"
      : !headMeta
        ? "removed"
        : "modified";

    const { diffLines } = getDashboardDiff(baseRef, headSha, filePath);

    diffs.push({
      file: path.basename(filePath),
      title: headMeta.title,
      uid: headMeta.uid,
      status,
      summary: summarizeDiff(baseMeta, headMeta),
      diffLines,
    });
  }

  return buildPreviewComment(diffs, fork);
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("dashboard-preview-bot.ts")) {
  runDashboardPreview()
    .then((comment) => {
      // Write comment to stdout for capture by GitHub Actions
      console.log("---COMMENT_BODY_START---");
      console.log(comment.body);
      console.log("---COMMENT_BODY_END---");
    })
    .catch((err) => {
      console.error("Dashboard preview bot failed:", err);
      process.exit(1);
    });
}

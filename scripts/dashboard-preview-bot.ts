/**
 * dashboard-preview-bot.ts
 *
 * PR-comment bot that renders dashboard JSON diffs and PNG panel previews for reviewers.
 * Suppresses output on fork PRs to avoid leaking internal dashboards.
 *
 * Usage:
 *   BASE_REF=origin/main \
 *   HEAD_SHA=$(git rev-parse HEAD) \
 *   GITHUB_REPOSITORY=owner/repo \
 *   GITHUB_EVENT_NAME=pull_request \
 *   HEAD_REPO=owner/repo \
 *   npx tsx scripts/dashboard-preview-bot.ts
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PanelInfo {
  id: number;
  title: string;
  type: string;
}

export type PanelChangeStatus = "added" | "removed" | "modified" | "unchanged";

export interface PanelChange {
  id: number;
  title: string;
  type: string;
  status: PanelChangeStatus;
}

export interface DashboardFile {
  name: string;
  path: string;
  uid: string;
  title: string;
  panelCount: number;
  panels: PanelInfo[];
}

export type DashboardParseResult =
  | { ok: true; meta: DashboardFile }
  | { ok: false; error: string };

export interface DashboardDiff {
  file: string;
  title: string;
  uid: string;
  status: "added" | "removed" | "modified" | "invalid";
  summary: string;
  diffLines: string[];
  panelChanges: PanelChange[];
  invalidJsonNote?: string;
  previewPngPath?: string;
}

export interface PreviewComment {
  body: string;
  pngPaths: string[];
}

export const DEFAULT_OUTPUT_DIR = "dashboard-preview-out";
export const MAX_DIFF_LINES = 200;
export const MAX_PREVIEW_PANELS = 20;
/** Embed PNG inline only when below this size (bytes). */
export const MAX_INLINE_PNG_BYTES = 50_000;

// ─── Dashboard parsing ───────────────────────────────────────────────────────

function panelsFromContent(content: unknown): PanelInfo[] {
  if (!content || typeof content !== "object") return [];
  const panels = (content as { panels?: unknown }).panels;
  if (!Array.isArray(panels)) return [];
  return panels
    .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
    .map((p) => ({
      id: typeof p.id === "number" ? p.id : -1,
      title: typeof p.title === "string" ? p.title : "(untitled)",
      type: typeof p.type === "string" ? p.type : "unknown",
    }))
    .filter((p) => p.id >= 0);
}

export function parseDashboardContent(
  content: string,
  filePath: string,
): DashboardParseResult {
  try {
    const parsed = JSON.parse(content);
    const panels = panelsFromContent(parsed);
    return {
      ok: true,
      meta: {
        name: path.basename(filePath, ".json"),
        path: filePath,
        uid: typeof parsed.uid === "string" ? parsed.uid : "unknown",
        title: typeof parsed.title === "string" ? parsed.title : "Untitled",
        panelCount: panels.length,
        panels,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function readDashboardMeta(filePath: string): DashboardFile | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const result = parseDashboardContent(content, filePath);
    return result.ok ? result.meta : null;
  } catch {
    return null;
  }
}

export function tryParseDashboardFile(filePath: string): DashboardParseResult {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return parseDashboardContent(content, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function tryParseDashboardFromGit(
  ref: string,
  relativePath: string,
): DashboardParseResult | null {
  try {
    const content = execSync(`git show ${ref}:${relativePath}`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseDashboardContent(content, relativePath);
  } catch {
    return null;
  }
}

export function findDashboardFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f))
      .filter((fp) => readDashboardMeta(fp) !== null);
  } catch {
    return [];
  }
}

// ─── Panel diff ──────────────────────────────────────────────────────────────

export function diffPanels(
  basePanels: PanelInfo[],
  headPanels: PanelInfo[],
): PanelChange[] {
  const baseById = new Map(basePanels.map((p) => [p.id, p]));
  const headById = new Map(headPanels.map((p) => [p.id, p]));
  const changes: PanelChange[] = [];

  for (const [id, panel] of headById) {
    const base = baseById.get(id);
    if (!base) {
      changes.push({ ...panel, status: "added" });
    } else if (base.title !== panel.title || base.type !== panel.type) {
      changes.push({ ...panel, status: "modified" });
    } else {
      changes.push({ ...panel, status: "unchanged" });
    }
  }

  for (const [id, panel] of baseById) {
    if (!headById.has(id)) {
      changes.push({ ...panel, status: "removed" });
    }
  }

  return changes.sort((a, b) => a.id - b.id);
}

export function summarizePanelChanges(changes: PanelChange[]): string {
  const added = changes.filter((c) => c.status === "added");
  const removed = changes.filter((c) => c.status === "removed");
  const modified = changes.filter((c) => c.status === "modified");

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`**Added panels:** ${added.map((p) => `"${p.title}"`).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`**Removed panels:** ${removed.map((p) => `"${p.title}"`).join(", ")}`);
  }
  if (modified.length > 0) {
    parts.push(`**Modified panels:** ${modified.map((p) => `"${p.title}"`).join(", ")}`);
  }
  if (parts.length === 0) return "_No panel-level changes detected._";
  return parts.join("\n");
}

export function summarizeDiff(
  base: DashboardFile | null,
  head: DashboardFile | null,
  panelChanges: PanelChange[] = [],
): string {
  if (!base && head) return `${head.title} (${head.panelCount} panels) — ADDED`;
  if (base && !head) return `${base.title} (${base.panelCount} panels) — REMOVED`;
  if (!base && !head) return "Unknown";

  const structural: string[] = [];
  if (base!.title !== head!.title) structural.push("title changed");
  if (base!.panelCount !== head!.panelCount) {
    structural.push(`${base!.panelCount} → ${head!.panelCount} panels`);
  }

  const changedPanels = panelChanges.filter((p) => p.status !== "unchanged");
  if (changedPanels.length > 0) {
    structural.push(
      `${changedPanels.length} panel change(s): ${changedPanels
        .slice(0, 5)
        .map((p) => `${p.title} (${p.status})`)
        .join(", ")}${changedPanels.length > 5 ? "…" : ""}`,
    );
  }

  return structural.length > 0
    ? `${head!.title} — ${structural.join("; ")}`
    : `${head!.title} — no structural changes`;
}

// ─── Git diff helpers ────────────────────────────────────────────────────────

export function getDashboardDiff(
  baseRef: string,
  headSha: string,
  relativePath: string,
): { diffLines: string[]; rawDiff: string } {
  try {
    const rawDiff = execSync(`git diff ${baseRef}...${headSha} -- "${relativePath}"`, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = rawDiff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    return { diffLines: lines, rawDiff };
  } catch {
    return { diffLines: [], rawDiff: "" };
  }
}

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

export function truncateDiffLines(lines: string[], maxLines = MAX_DIFF_LINES): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `... (+${lines.length - maxLines} more lines)`];
}

// ─── Fork detection ──────────────────────────────────────────────────────────

export function isForkPr(): boolean {
  const headRepo = process.env.HEAD_REPO || "";
  const baseRepo = process.env.GITHUB_REPOSITORY || "";
  const eventName = process.env.GITHUB_EVENT_NAME || "";

  if (eventName === "pull_request") {
    if (!headRepo) return true;
    return headRepo !== baseRepo;
  }

  return headRepo !== "" && headRepo !== baseRepo;
}

// ─── Minimal PNG encoder (no external deps) ──────────────────────────────────

const STATUS_COLORS: Record<PanelChangeStatus, [number, number, number]> = {
  added: [34, 197, 94],
  removed: [239, 68, 68],
  modified: [234, 179, 8],
  unchanged: [148, 163, 184],
};

/** 5×7 bitmap font for printable ASCII (32–126). Each char is 7 rows of 5 bits. */
const FONT5X7: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "!": [4, 4, 4, 4, 0, 4, 0],
  '"': [10, 10, 10, 0, 0, 0, 0],
  "#": [10, 31, 10, 31, 10, 0, 0],
  $: [14, 21, 14, 21, 14, 0, 0],
  "%": [17, 2, 4, 8, 17, 0, 0],
  "&": [12, 18, 12, 18, 13, 0, 0],
  "'": [4, 4, 4, 0, 0, 0, 0],
  "(": [8, 4, 4, 4, 4, 8, 0],
  ")": [2, 4, 4, 4, 4, 2, 0],
  "*": [0, 4, 21, 14, 21, 4, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  ",": [0, 0, 0, 0, 4, 4, 8],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 4, 0],
  "/": [1, 2, 4, 8, 16, 0, 0],
  "0": [14, 17, 19, 21, 25, 14, 0],
  "1": [4, 12, 4, 4, 4, 14, 0],
  "2": [14, 17, 1, 14, 16, 31, 0],
  "3": [14, 17, 6, 1, 17, 14, 0],
  "4": [2, 6, 10, 18, 31, 2, 0],
  "5": [31, 16, 30, 1, 17, 14, 0],
  "6": [14, 16, 30, 17, 17, 14, 0],
  "7": [31, 1, 2, 4, 8, 8, 0],
  "8": [14, 17, 14, 17, 17, 14, 0],
  "9": [14, 17, 17, 15, 1, 14, 0],
  ":": [0, 4, 0, 0, 4, 0, 0],
  ";": [0, 4, 0, 0, 4, 4, 8],
  "<": [2, 4, 8, 16, 8, 4, 2],
  "=": [0, 0, 31, 0, 31, 0, 0],
  ">": [8, 4, 2, 1, 2, 4, 8],
  "?": [14, 17, 2, 4, 0, 4, 0],
  "@": [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 0],
  B: [30, 17, 30, 17, 17, 30, 0],
  C: [14, 17, 16, 16, 17, 14, 0],
  D: [30, 17, 17, 17, 17, 30, 0],
  E: [31, 16, 30, 16, 16, 31, 0],
  F: [31, 16, 30, 16, 16, 16, 0],
  G: [14, 17, 16, 19, 17, 15, 0],
  H: [17, 17, 31, 17, 17, 17, 0],
  I: [14, 4, 4, 4, 4, 14, 0],
  J: [7, 2, 2, 2, 18, 12, 0],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 31, 0],
  M: [17, 27, 21, 17, 17, 17, 0],
  N: [17, 25, 21, 19, 17, 17, 0],
  O: [14, 17, 17, 17, 17, 14, 0],
  P: [30, 17, 17, 30, 16, 16, 0],
  Q: [14, 17, 17, 17, 21, 14, 2],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 14, 1, 17, 14, 0],
  T: [31, 4, 4, 4, 4, 4, 0],
  U: [17, 17, 17, 17, 17, 14, 0],
  V: [17, 17, 17, 17, 10, 4, 0],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 0],
  Z: [31, 1, 2, 4, 8, 31, 0],
  "[": [14, 8, 8, 8, 8, 14, 0],
  "\\": [16, 8, 4, 2, 1, 0, 0],
  "]": [14, 2, 2, 2, 2, 14, 0],
  "^": [4, 10, 17, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  "`": [8, 4, 0, 0, 0, 0, 0],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 30, 17, 17, 30, 0],
  c: [0, 0, 14, 16, 16, 14, 0],
  d: [1, 1, 15, 17, 17, 15, 0],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 8, 31, 8, 8, 8, 0],
  g: [0, 0, 15, 17, 15, 1, 14],
  h: [16, 16, 30, 17, 17, 17, 0],
  i: [4, 0, 12, 4, 4, 14, 0],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 14, 0],
  m: [0, 0, 26, 21, 21, 21, 0],
  n: [0, 0, 22, 17, 17, 17, 0],
  o: [0, 0, 14, 17, 17, 14, 0],
  p: [0, 0, 30, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 15, 1, 1],
  r: [0, 0, 22, 24, 16, 16, 0],
  s: [0, 0, 14, 16, 14, 1, 30],
  t: [8, 8, 31, 8, 8, 8, 0],
  u: [0, 0, 17, 17, 17, 15, 0],
  v: [0, 0, 17, 17, 10, 4, 0],
  w: [0, 0, 17, 21, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
  "{": [6, 4, 4, 8, 4, 4, 6],
  "|": [4, 4, 4, 4, 4, 4, 4],
  "}": [12, 4, 4, 2, 4, 4, 12],
  "~": [0, 8, 21, 2, 0, 0, 0],
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const rowSize = width * 4;
  const raw = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (rowSize + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < rowSize; x++) {
      raw[rowOffset + 1 + x] = rgba[y * rowSize + x]!;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export class SimpleCanvas {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  constructor(width: number, height: number, bg: [number, number, number] = [30, 41, 59]) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  private idx(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: [number, number, number],
  ): void {
    for (let py = y; py < y + h; py++) {
      if (py < 0 || py >= this.height) continue;
      for (let px = x; px < x + w; px++) {
        if (px < 0 || px >= this.width) continue;
        const i = this.idx(px, py);
        this.pixels[i] = color[0];
        this.pixels[i + 1] = color[1];
        this.pixels[i + 2] = color[2];
        this.pixels[i + 3] = 255;
      }
    }
  }

  drawText(
    x: number,
    y: number,
    text: string,
    color: [number, number, number] = [248, 250, 252],
    scale = 2,
  ): void {
    let cx = x;
    for (const ch of text) {
      const glyph = FONT5X7[ch] ?? FONT5X7["?"];
      for (let row = 0; row < 7; row++) {
        const bits = glyph[row] ?? 0;
        for (let col = 0; col < 5; col++) {
          if (bits & (1 << (4 - col))) {
            this.fillRect(cx + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cx += 6 * scale;
    }
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.pixels);
  }
}

export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

export function renderDashboardPreviewPng(
  dashboardTitle: string,
  panelChanges: PanelChange[],
  options: { maxPanels?: number; cardHeight?: number; width?: number } = {},
): Buffer {
  const width = options.width ?? 480;
  const cardHeight = options.cardHeight ?? 52;
  const headerHeight = 36;
  const maxPanels = options.maxPanels ?? MAX_PREVIEW_PANELS;
  const visible = panelChanges.slice(0, maxPanels);
  const omitted = panelChanges.length - visible.length;
  const height = headerHeight + visible.length * cardHeight + (omitted > 0 ? 24 : 0);

  const canvas = new SimpleCanvas(width, height);
  canvas.drawText(8, 8, truncateText(dashboardTitle, 40), [248, 250, 252], 2);

  let y = headerHeight;
  for (const panel of visible) {
    const [r, g, b] = STATUS_COLORS[panel.status];
    canvas.fillRect(0, y, 8, cardHeight - 4, [r, g, b]);
    canvas.drawText(16, y + 8, truncateText(panel.title, 28), [248, 250, 252], 2);
    canvas.drawText(16, y + 28, `${panel.type} · ${panel.status}`, [148, 163, 184], 1);
    y += cardHeight;
  }

  if (omitted > 0) {
    canvas.drawText(8, y + 4, `+${omitted} more panel(s) not shown`, [148, 163, 184], 1);
  }

  return canvas.toPng();
}

export function writeDashboardPreviews(
  diffs: DashboardDiff[],
  outputDir: string,
): string[] {
  fs.mkdirSync(outputDir, { recursive: true });
  const written: string[] = [];

  for (const diff of diffs) {
    if (diff.status === "invalid") continue;
    const panels =
      diff.panelChanges.length > 0
        ? diff.panelChanges
        : [{ id: 0, title: diff.title, type: "dashboard", status: diff.status as PanelChangeStatus }];
    const png = renderDashboardPreviewPng(diff.title, panels);
    const safeName = diff.file.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outPath = path.join(outputDir, `${safeName}.png`);
    fs.writeFileSync(outPath, png);
    diff.previewPngPath = outPath;
    written.push(outPath);
  }

  return written;
}

export function pngToDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`;
}

// ─── Comment builder ─────────────────────────────────────────────────────────

export function buildPreviewComment(
  diffs: DashboardDiff[],
  isFork: boolean,
  options: { artifactName?: string } = {},
): PreviewComment {
  const lines: string[] = [];
  const pngPaths: string[] = diffs
    .map((d) => d.previewPngPath)
    .filter((p): p is string => Boolean(p));

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
    return { body: lines.join("\n"), pngPaths: [] };
  }

  if (diffs.length === 0) {
    lines.push("## 🖼️ Dashboard Preview");
    lines.push("");
    lines.push("✅ No dashboard changes detected.");
    return { body: lines.join("\n"), pngPaths: [] };
  }

  lines.push("## 🖼️ Dashboard Preview");
  lines.push("");
  lines.push(`Found **${diffs.length}** dashboard file(s) with changes:\n`);

  for (const diff of diffs) {
    lines.push(`### ${diff.title} (\`${diff.file}\`)`);
    lines.push(`**Status:** ${diff.status}`);
    lines.push(`**Summary:** ${diff.summary}`);

    if (diff.invalidJsonNote) {
      lines.push("");
      lines.push(`> ⚠️ **Invalid JSON:** ${diff.invalidJsonNote}`);
    }

    if (diff.panelChanges.length > 0) {
      lines.push("");
      lines.push("**Panel changes:**");
      lines.push(summarizePanelChanges(diff.panelChanges));
    }

    if (diff.previewPngPath && fs.existsSync(diff.previewPngPath)) {
      const png = fs.readFileSync(diff.previewPngPath);
      lines.push("");
      if (png.length <= MAX_INLINE_PNG_BYTES) {
        lines.push(`![${diff.title} preview](${pngToDataUri(png)})`);
      } else {
        const artifact = options.artifactName ?? "dashboard-preview-pngs";
        lines.push(
          `_PNG preview (${path.basename(diff.previewPngPath)}, ${Math.round(png.length / 1024)} KB) uploaded as workflow artifact \`${artifact}\`._`,
        );
      }
    }

    if (diff.diffLines.length > 0) {
      lines.push("");
      lines.push("<details>");
      lines.push("<summary>📝 JSON Diff</summary>");
      lines.push("");
      lines.push("```diff");
      lines.push(...truncateDiffLines(diff.diffLines));
      lines.push("```");
      lines.push("</details>");
    }

    lines.push("");
  }

  if (pngPaths.length > 0) {
    const artifact = options.artifactName ?? "dashboard-preview-pngs";
    lines.push(
      `📎 **PNG previews** (${pngPaths.length} file(s)) are available in the workflow artifact \`${artifact}\`.`,
    );
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Generated by [dashboard-preview-bot](https://github.com/Chronopay-Org/ChronoPay-Backend/actions)._",
  );

  return { body: lines.join("\n"), pngPaths };
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runDashboardPreview(): Promise<PreviewComment> {
  const baseRef = process.env.BASE_REF || "origin/main";
  const headSha = process.env.HEAD_SHA || "HEAD";
  const dashboardDir = process.env.DASHBOARD_DIR || "ops/dashboards";
  const outputDir = process.env.PREVIEW_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

  const fork = isForkPr();
  if (fork) {
    return buildPreviewComment([], true);
  }

  const changedFiles = findChangedDashboards(baseRef, headSha, dashboardDir);
  const diffs: DashboardDiff[] = [];

  for (const filePath of changedFiles) {
    const absPath = path.resolve(filePath);
    const headExists = fs.existsSync(absPath);
    const baseParse = tryParseDashboardFromGit(baseRef, filePath);
    const { diffLines } = getDashboardDiff(baseRef, headSha, filePath);

    if (!headExists) {
      if (!baseParse?.ok) {
        diffs.push({
          file: path.basename(filePath),
          title: path.basename(filePath, ".json"),
          uid: "unknown",
          status: "invalid",
          summary: "Dashboard file removed but base version could not be parsed",
          diffLines: truncateDiffLines(diffLines),
          panelChanges: [],
          invalidJsonNote: baseParse && !baseParse.ok ? baseParse.error : "Base file not found in git",
        });
        continue;
      }

      const panelChanges = diffPanels(baseParse.meta.panels, []);
      diffs.push({
        file: path.basename(filePath),
        title: baseParse.meta.title,
        uid: baseParse.meta.uid,
        status: "removed",
        summary: summarizeDiff(baseParse.meta, null, panelChanges),
        diffLines: truncateDiffLines(diffLines),
        panelChanges,
      });
      continue;
    }

    const headParse = tryParseDashboardFile(absPath);
    if (!headParse.ok) {
      diffs.push({
        file: path.basename(filePath),
        title: path.basename(filePath, ".json"),
        uid: "unknown",
        status: "invalid",
        summary: "Dashboard file contains invalid JSON",
        diffLines: truncateDiffLines(diffLines),
        panelChanges: [],
        invalidJsonNote: headParse.error,
      });
      continue;
    }

    const baseMeta = baseParse?.ok ? baseParse.meta : null;
    const headMeta = headParse.meta;
    const status: DashboardDiff["status"] = !baseMeta
      ? "added"
      : "modified";
    const panelChanges = diffPanels(baseMeta?.panels ?? [], headMeta.panels);

    diffs.push({
      file: path.basename(filePath),
      title: headMeta.title,
      uid: headMeta.uid,
      status,
      summary: summarizeDiff(baseMeta, headMeta, panelChanges),
      diffLines: truncateDiffLines(diffLines),
      panelChanges,
    });
  }

  writeDashboardPreviews(diffs, outputDir);
  return buildPreviewComment(diffs, false, {
    artifactName: process.env.PREVIEW_ARTIFACT_NAME,
  });
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("dashboard-preview-bot.ts")) {
  runDashboardPreview()
    .then((comment) => {
      console.log("---COMMENT_BODY_START---");
      console.log(comment.body);
      console.log("---COMMENT_BODY_END---");
      if (comment.pngPaths.length > 0) {
        console.log("---PNG_PATHS_START---");
        console.log(comment.pngPaths.join("\n"));
        console.log("---PNG_PATHS_END---");
      }
    })
    .catch((err) => {
      console.error("Dashboard preview bot failed:", err);
      process.exit(1);
    });
}

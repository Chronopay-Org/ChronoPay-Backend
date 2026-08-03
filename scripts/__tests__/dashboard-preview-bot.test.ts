import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";

import {
  readDashboardMeta,
  findDashboardFiles,
  summarizeDiff,
  summarizePanelChanges,
  buildPreviewComment,
  isForkPr,
  parseDashboardContent,
  diffPanels,
  truncateDiffLines,
  encodePng,
  SimpleCanvas,
  renderDashboardPreviewPng,
  writeDashboardPreviews,
  pngToDataUri,
  MAX_DIFF_LINES,
  MAX_INLINE_PNG_BYTES,
  type DashboardDiff,
  type PanelChange,
} from "../dashboard-preview-bot.js";

describe("dashboard-preview-bot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-preview-test-"));
    delete process.env.HEAD_REPO;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_EVENT_NAME;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parseDashboardContent / readDashboardMeta", () => {
    it("extracts metadata from valid dashboard JSON", () => {
      const filePath = path.join(tmpDir, "test-dash.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          uid: "test-uid",
          title: "Test Dashboard",
          panels: [
            { id: 1, type: "stat", title: "Uptime" },
            { id: 2, type: "timeseries", title: "Latency" },
          ],
        }),
      );

      const meta = readDashboardMeta(filePath);
      expect(meta).not.toBeNull();
      expect(meta!.uid).toBe("test-uid");
      expect(meta!.title).toBe("Test Dashboard");
      expect(meta!.panelCount).toBe(2);
      expect(meta!.panels).toHaveLength(2);
    });

    it("returns null for invalid JSON via readDashboardMeta", () => {
      const filePath = path.join(tmpDir, "bad.json");
      fs.writeFileSync(filePath, "not json {{{");
      expect(readDashboardMeta(filePath)).toBeNull();
    });

    it("returns explicit error for invalid JSON via parseDashboardContent", () => {
      const result = parseDashboardContent("not json", "bad.json");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });

  describe("findDashboardFiles", () => {
    it("finds only valid dashboard JSON files", () => {
      fs.writeFileSync(
        path.join(tmpDir, "valid.json"),
        JSON.stringify({ uid: "1", title: "Valid", panels: [] }),
      );
      fs.writeFileSync(path.join(tmpDir, "invalid.json"), "not json");
      fs.writeFileSync(path.join(tmpDir, "readme.md"), "# readme");

      const files = findDashboardFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("valid.json");
    });

    it("returns empty array for non-existent directory", () => {
      expect(findDashboardFiles("/nonexistent/dir")).toEqual([]);
    });
  });

  describe("diffPanels", () => {
    it("detects added, removed, and modified panels by id", () => {
      const base = [
        { id: 1, title: "Keep", type: "stat" },
        { id: 2, title: "Old Title", type: "stat" },
        { id: 3, title: "Gone", type: "graph" },
      ];
      const head = [
        { id: 1, title: "Keep", type: "stat" },
        { id: 2, title: "New Title", type: "stat" },
        { id: 4, title: "Fresh", type: "table" },
      ];

      const changes = diffPanels(base, head);
      expect(changes.find((c) => c.id === 3)?.status).toBe("removed");
      expect(changes.find((c) => c.id === 4)?.status).toBe("added");
      expect(changes.find((c) => c.id === 2)?.status).toBe("modified");
      expect(changes.find((c) => c.id === 1)?.status).toBe("unchanged");
    });
  });

  describe("summarizePanelChanges", () => {
    it("lists added and removed panel titles", () => {
      const changes: PanelChange[] = [
        { id: 1, title: "New Panel", type: "stat", status: "added" },
        { id: 2, title: "Old Panel", type: "graph", status: "removed" },
      ];
      const summary = summarizePanelChanges(changes);
      expect(summary).toContain("Added panels");
      expect(summary).toContain('"New Panel"');
      expect(summary).toContain("Removed panels");
      expect(summary).toContain('"Old Panel"');
    });
  });

  describe("summarizeDiff", () => {
    it("describes an added dashboard", () => {
      const head = {
        name: "test",
        path: "",
        uid: "1",
        title: "Test",
        panelCount: 5,
        panels: [],
      };
      expect(summarizeDiff(null, head)).toContain("ADDED");
    });

    it("describes a removed dashboard", () => {
      const base = {
        name: "test",
        path: "",
        uid: "1",
        title: "Test",
        panelCount: 5,
        panels: [],
      };
      expect(summarizeDiff(base, null)).toContain("REMOVED");
    });

    it("describes panel count changes", () => {
      const base = {
        name: "test",
        path: "",
        uid: "1",
        title: "Test",
        panelCount: 3,
        panels: [],
      };
      const head = { ...base, panelCount: 5 };
      expect(summarizeDiff(base, head)).toContain("3 → 5 panels");
    });
  });

  describe("truncateDiffLines", () => {
    it("truncates large diffs at MAX_DIFF_LINES", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `+ line ${i}`);
      const truncated = truncateDiffLines(lines);
      expect(truncated).toHaveLength(MAX_DIFF_LINES + 1);
      expect(truncated[truncated.length - 1]).toMatch(/\+100 more lines/);
    });
  });

  describe("buildPreviewComment", () => {
    it("shows suppressed message for fork PRs", () => {
      const result = buildPreviewComment([], true);
      expect(result.body).toContain("suppressed for fork PRs");
    });

    it("shows no-dashboard-changes message when empty", () => {
      const result = buildPreviewComment([], false);
      expect(result.body).toContain("No dashboard changes detected");
    });

    it("includes panel changes and JSON diff", () => {
      const diffs: DashboardDiff[] = [
        {
          file: "example-dashboard.json",
          title: "Example Dashboard",
          uid: "example-dash",
          status: "modified",
          summary: "Example Dashboard — 2 → 3 panels",
          diffLines: ['+  "version": 2', '-  "version": 1'],
          panelChanges: [
            { id: 3, title: "New Panel", type: "stat", status: "added" },
          ],
        },
      ];

      const result = buildPreviewComment(diffs, false);
      expect(result.body).toMatch(/Found \*\*1\*\* dashboard file/);
      expect(result.body).toContain("Example Dashboard");
      expect(result.body).toContain("Added panels");
      expect(result.body).toContain("New Panel");
      expect(result.body).toContain("JSON Diff");
      expect(result.body).toContain('+  "version": 2');
    });

    it("includes invalid JSON note for non-JSON dashboards", () => {
      const diffs: DashboardDiff[] = [
        {
          file: "broken.json",
          title: "broken",
          uid: "unknown",
          status: "invalid",
          summary: "Dashboard file contains invalid JSON",
          diffLines: [],
          panelChanges: [],
          invalidJsonNote: "Unexpected token",
        },
      ];

      const result = buildPreviewComment(diffs, false);
      expect(result.body).toContain("Invalid JSON");
      expect(result.body).toContain("Unexpected token");
    });

    it("describes removed dashboard with panel list", () => {
      const diffs: DashboardDiff[] = [
        {
          file: "gone.json",
          title: "Removed Dash",
          uid: "gone",
          status: "removed",
          summary: "Removed Dash (2 panels) — REMOVED",
          diffLines: ['-  "title": "Removed Dash"'],
          panelChanges: [
            { id: 1, title: "Panel A", type: "stat", status: "removed" },
          ],
        },
      ];

      const result = buildPreviewComment(diffs, false);
      expect(result.body).toContain("**Status:** removed");
      expect(result.body).toContain("Removed panels");
      expect(result.body).toContain("Panel A");
    });

    it("truncates large JSON diff in comment", () => {
      const diffs: DashboardDiff[] = [
        {
          file: "big.json",
          title: "Big",
          uid: "big",
          status: "modified",
          summary: "Big",
          diffLines: Array.from({ length: 250 }, (_, i) => `+ line${i}`),
          panelChanges: [],
        },
      ];

      const result = buildPreviewComment(diffs, false);
      expect(result.body).toContain("more lines");
    });
  });

  describe("isForkPr", () => {
    it("treats missing HEAD_REPO as fork when event is pull_request", () => {
      process.env.GITHUB_EVENT_NAME = "pull_request";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      expect(isForkPr()).toBe(true);
    });

    it("returns false when HEAD_REPO matches GITHUB_REPOSITORY on pull_request", () => {
      process.env.GITHUB_EVENT_NAME = "pull_request";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.HEAD_REPO = "owner/repo";
      expect(isForkPr()).toBe(false);
    });

    it("returns true when HEAD_REPO differs from GITHUB_REPOSITORY", () => {
      process.env.GITHUB_EVENT_NAME = "pull_request";
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.HEAD_REPO = "forker/repo";
      expect(isForkPr()).toBe(true);
    });

    it("returns false when HEAD_REPO missing outside pull_request events", () => {
      process.env.GITHUB_REPOSITORY = "owner/repo";
      expect(isForkPr()).toBe(false);
    });
  });

  describe("PNG generation", () => {
    it("encodePng produces valid PNG signature", () => {
      const canvas = new SimpleCanvas(32, 16);
      canvas.fillRect(4, 4, 20, 8, [34, 197, 94]);
      const png = encodePng(canvas.width, canvas.height, canvas.pixels);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    });

    it("renderDashboardPreviewPng returns a non-empty buffer", () => {
      const panels: PanelChange[] = [
        { id: 1, title: "Revenue", type: "stat", status: "added" },
        { id: 2, title: "Errors", type: "timeseries", status: "removed" },
      ];
      const png = renderDashboardPreviewPng("Ops Dashboard", panels);
      expect(png.length).toBeGreaterThan(100);
      expect(png.subarray(0, 4).toString("hex")).toBe("89504e47");
    });

    it("truncates large dashboards in PNG preview", () => {
      const panels: PanelChange[] = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        title: `Panel ${i + 1}`,
        type: "stat",
        status: "unchanged" as const,
      }));
      const png = renderDashboardPreviewPng("Large Dashboard", panels, { maxPanels: 20 });
      expect(png.length).toBeGreaterThan(100);
    });

    it("writeDashboardPreviews writes PNG files to output dir", () => {
      const outDir = path.join(tmpDir, "preview-out");
      const diffs: DashboardDiff[] = [
        {
          file: "example.json",
          title: "Example",
          uid: "ex",
          status: "modified",
          summary: "Example",
          diffLines: [],
          panelChanges: [{ id: 1, title: "A", type: "stat", status: "added" }],
        },
      ];

      const written = writeDashboardPreviews(diffs, outDir);
      expect(written).toHaveLength(1);
      expect(fs.existsSync(written[0]!)).toBe(true);
      expect(diffs[0]!.previewPngPath).toBe(written[0]);
    });

    it("pngToDataUri produces embeddable data URI", () => {
      const png = renderDashboardPreviewPng("Test", [
        { id: 1, title: "X", type: "stat", status: "added" },
      ]);
      expect(png.length).toBeLessThan(MAX_INLINE_PNG_BYTES);
      const uri = pngToDataUri(png);
      expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    });

    it("buildPreviewComment embeds small PNG inline", () => {
      const outDir = path.join(tmpDir, "inline-out");
      const diffs: DashboardDiff[] = [
        {
          file: "small.json",
          title: "Small",
          uid: "s",
          status: "added",
          summary: "Small",
          diffLines: [],
          panelChanges: [{ id: 1, title: "One", type: "stat", status: "added" }],
        },
      ];
      writeDashboardPreviews(diffs, outDir);
      const result = buildPreviewComment(diffs, false);
      expect(result.body).toContain("data:image/png;base64,");
    });
  });
});

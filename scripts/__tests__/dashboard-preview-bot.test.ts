import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";

// We import the module under test using dynamic import after setup
let dashboardPreviewBot: typeof import("../dashboard-preview-bot.js");

describe("dashboard-preview-bot", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-preview-test-"));
    jest.resetModules();
    // Re-import with clean env
    dashboardPreviewBot = await import("../dashboard-preview-bot.js");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readDashboardMeta", () => {
    it("extracts metadata from a valid dashboard JSON file", () => {
      const filePath = path.join(tmpDir, "test-dash.json");
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          uid: "test-uid",
          title: "Test Dashboard",
          panels: [{ id: 1, type: "stat" }, { id: 2, type: "timeseries" }],
        }),
      );

      const meta = dashboardPreviewBot.readDashboardMeta(filePath);
      expect(meta).not.toBeNull();
      expect(meta!.uid).toBe("test-uid");
      expect(meta!.title).toBe("Test Dashboard");
      expect(meta!.panelCount).toBe(2);
    });

    it("returns null for invalid JSON", () => {
      const filePath = path.join(tmpDir, "bad.json");
      fs.writeFileSync(filePath, "not json");
      expect(dashboardPreviewBot.readDashboardMeta(filePath)).toBeNull();
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

      const files = dashboardPreviewBot.findDashboardFiles(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain("valid.json");
    });

    it("returns empty array for non-existent directory", () => {
      expect(dashboardPreviewBot.findDashboardFiles("/nonexistent/dir")).toEqual([]);
    });
  });

  describe("summarizeDiff", () => {
    it("describes an added dashboard", () => {
      const head = { name: "test", path: "", uid: "1", title: "Test", panelCount: 5 };
      const result = dashboardPreviewBot.summarizeDiff(null, head);
      expect(result).toContain("ADDED");
      expect(result).toContain("5 panels");
    });

    it("describes a removed dashboard", () => {
      const base = { name: "test", path: "", uid: "1", title: "Test", panelCount: 5 };
      const result = dashboardPreviewBot.summarizeDiff(base, null);
      expect(result).toContain("REMOVED");
    });

    it("describes a modified dashboard with panel count change", () => {
      const base = { name: "test", path: "", uid: "1", title: "Test", panelCount: 3 };
      const head = { name: "test", path: "", uid: "1", title: "Test", panelCount: 5 };
      const result = dashboardPreviewBot.summarizeDiff(base, head);
      expect(result).toContain("3 → 5 panels");
    });

    it("reports no structural changes when same", () => {
      const base = { name: "test", path: "", uid: "1", title: "Test", panelCount: 5 };
      const head = { name: "test", path: "", uid: "1", title: "Test", panelCount: 5 };
      const result = dashboardPreviewBot.summarizeDiff(base, head);
      expect(result).toContain("no structural changes");
    });
  });

  describe("buildPreviewComment", () => {
    it("shows suppressed message for fork PRs", () => {
      const result = dashboardPreviewBot.buildPreviewComment([], true);
      expect(result.body).toContain("suppressed for fork PRs");
    });

    it("shows no-dashboard-changes message when empty and not fork", () => {
      const result = dashboardPreviewBot.buildPreviewComment([], false);
      expect(result.body).toContain("No dashboard changes detected");
    });

    it("includes diff details when dashboards have changed", () => {
      const diffs = [
        {
          file: "example-dashboard.json",
          title: "Example Dashboard",
          uid: "example-dash",
          status: "modified" as const,
          summary: "Example Dashboard — 2 → 3 panels",
          diffLines: ["+  \"version\": 2", "-  \"version\": 1"],
        },
      ];

      const result = dashboardPreviewBot.buildPreviewComment(diffs, false);
      expect(result.body).toMatch(/Found \*\*1\*\* dashboard file/);
      expect(result.body).toContain("Example Dashboard");
      expect(result.body).toContain("JSON Diff");
      expect(result.body).toContain("+  \"version\": 2");
      expect(result.body).toContain("dashboard-preview-bot");
    });
  });

  describe("isForkPr", () => {
    beforeEach(() => {
      delete process.env.HEAD_REPO;
      delete process.env.GITHUB_REPOSITORY;
    });

    it("returns false when HEAD_REPO is not set", () => {
      process.env.GITHUB_REPOSITORY = "owner/repo";
      expect(dashboardPreviewBot.isForkPr()).toBe(false);
    });

    it("returns false when HEAD_REPO matches GITHUB_REPOSITORY", () => {
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.HEAD_REPO = "owner/repo";
      expect(dashboardPreviewBot.isForkPr()).toBe(false);
    });

    it("returns true when HEAD_REPO differs from GITHUB_REPOSITORY", () => {
      process.env.GITHUB_REPOSITORY = "owner/repo";
      process.env.HEAD_REPO = "forker/repo";
      expect(dashboardPreviewBot.isForkPr()).toBe(true);
    });
  });
});

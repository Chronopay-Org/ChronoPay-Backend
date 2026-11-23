import fs from "fs";
import path from "path";
import { GraphqlAllowlistService } from "../graphqlAllowlist.service.js";
import { rejectedAdhocQueries } from "../index.js";

describe("GraphqlAllowlistService", () => {
  const testDir = fs.mkdtempSync(path.join("/tmp", "graphql-allowlist-test-"));

  afterEach(() => {
    // Clean up any temp files created during tests
    const files = fs.readdirSync(testDir);
    for (const file of files) {
      fs.unlinkSync(path.join(testDir, file));
    }
  });

  describe("loadAllowlist", () => {
    it("should load a valid allowlist file", () => {
      const validFile = path.join(testDir, "valid.json");
      fs.writeFileSync(validFile, JSON.stringify({ queries: { "hash1": "query Test" } }));

      const svc = new GraphqlAllowlistService(validFile);
      expect(svc.isAllowed("hash1")).toBe(true);
    });

    it("should return false when file is missing", () => {
      const missingFile = path.join(testDir, "missing.json");
      const result = GraphqlAllowlistService.prototype.loadAllowlist.call(
        new GraphqlAllowlistService(),
        missingFile
      );
      expect(result).toBe(false);
    });

    it("should return false when file has invalid JSON", () => {
      const badFile = path.join(testDir, "bad.json");
      fs.writeFileSync(badFile, "not valid json");

      const svc = new GraphqlAllowlistService(badFile);
      // Allowlist should remain empty/previous state
      expect(svc.isAllowed("anything")).toBe(false);
    });

    it("should return false when file has JSON without queries key", () => {
      const noQueriesFile = path.join(testDir, "no-queries.json");
      fs.writeFileSync(noQueriesFile, JSON.stringify({ other: "data" }));

      const svc = new GraphqlAllowlistService(noQueriesFile);
      expect(svc.isAllowed("anything")).toBe(false);
    });

    it("should retain previous allowlist when new file fails", () => {
      const firstFile = path.join(testDir, "first.json");
      const secondFile = path.join(testDir, "second.json");

      // Load first allowlist
      fs.writeFileSync(firstFile, JSON.stringify({ queries: { "hash1": "query Test" } }));
      const svc1 = new GraphqlAllowlistService(firstFile);
      expect(svc1.isAllowed("hash1")).toBe(true);

      // Try to load second (fail) - allowlist should be retained
      fs.writeFileSync(secondFile, "invalid json");
      const result = svc1.loadAllowlist(secondFile);
      expect(result).toBe(false);
      // Previous hash should still be allowed
      expect(svc1.isAllowed("hash1")).toBe(true);
    });

    it("should override allowlist when new file succeeds", () => {
      const firstFile = path.join(testDir, "first.json");
      const secondFile = path.join(testDir, "second.json");

      // Load first allowlist
      fs.writeFileSync(firstFile, JSON.stringify({ queries: { "hash1": "query Test" } }));
      const svc = new GraphqlAllowlistService(firstFile);
      expect(svc.isAllowed("hash1")).toBe(true);

      // Load second allowlist (succeeds) - allowlist should be overwritten
      fs.writeFileSync(secondFile, JSON.stringify({ queries: { "hash2": "query Test2" } }));
      const result = svc.loadAllowlist(secondFile);
      expect(result).toBe(true);
      // Old hash should no longer be allowed, new hash should
      expect(svc.isAllowed("hash1")).toBe(false);
      expect(svc.isAllowed("hash2")).toBe(true);
    });
  });
});
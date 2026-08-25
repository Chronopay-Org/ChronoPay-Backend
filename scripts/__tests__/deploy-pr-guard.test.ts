import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import {
  createAuditEntry,
  isMergedPrResponse,
  validateDeployPrRecord,
} from "../deploy-pr-guard.js";

describe("deploy-pr-guard", () => {
  it("treats merged PR payloads as valid", () => {
    expect(
      isMergedPrResponse({
        number: 520,
        state: "closed",
        merged_at: "2026-08-24T12:00:00Z",
      })
    ).toBe(true);

    expect(
      isMergedPrResponse({
        number: 521,
        state: "open",
        merged_at: null,
      })
    ).toBe(false);
  });

  it("accepts a merged PR when linked to the deploy", async () => {
    const record = await validateDeployPrRecord({
      deployId: "deploy-001",
      repo: "Chronopay-Org/ChronoPay-Backend",
      prNumber: 520,
      sha: "abc123",
      manualOverride: false,
      fetchJson: async () => ({
        number: 520,
        state: "closed",
        merged_at: "2026-08-24T12:00:00Z",
      }),
    });

    expect(record.prNumber).toBe(520);
    expect(record.deployId).toBe("deploy-001");
    expect(record.status).toBe("approved");
  });

  it("rejects manual override and writes an alarm record", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-pr-guard-"));
    const ledgerPath = path.join(tmpDir, "deploy-ledger.jsonl");

    await expect(
      validateDeployPrRecord({
        deployId: "deploy-override",
        repo: "Chronopay-Org/ChronoPay-Backend",
        prNumber: 520,
        sha: "abc123",
        manualOverride: true,
        ledgerPath,
        fetchJson: async () => ({
          number: 520,
          state: "closed",
          merged_at: "2026-08-24T12:00:00Z",
        }),
      })
    ).rejects.toThrow("Manual override detected");

    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split(/\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[0]);
    expect(entry.event).toBe("manual_override_alarm");
    expect(entry.deployId).toBe("deploy-override");
  });

  it("creates a deploy PR audit entry", () => {
    const entry = createAuditEntry({
      deployId: "deploy-002",
      prNumber: 520,
      repo: "Chronopay-Org/ChronoPay-Backend",
      sha: "def456",
      event: "deploy_approved",
      status: "approved",
    });

    expect(entry.deployId).toBe("deploy-002");
    expect(entry.prNumber).toBe(520);
    expect(entry.event).toBe("deploy_approved");
    expect(entry.status).toBe("approved");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";
import { main, parseArgs, getFallbackCommit } from "../verify-deploy-pr.js";

describe("CLI script verify-deploy-pr - parseArgs", () => {
  it("parses CLI arguments correctly", () => {
    const parsed = parseArgs([
      "-c",
      "commit123",
      "-p",
      "42",
      "-e",
      "staging",
      "-t",
      "rollback",
      "--override",
      "--override-reason",
      "Emergency fix",
      "--ledger-path",
      "/tmp/ledger.json",
      "--json",
    ]);

    expect(parsed.commit).toBe("commit123");
    expect(parsed.pr).toBe(42);
    expect(parsed.environment).toBe("staging");
    expect(parsed.deployType).toBe("ROLLBACK");
    expect(parsed.override).toBe(true);
    expect(parsed.overrideReason).toBe("Emergency fix");
    expect(parsed.ledgerPath).toBe("/tmp/ledger.json");
    expect(parsed.json).toBe(true);
  });

  it("handles short flags -h, -c, -p, -e, -t", () => {
    const parsed = parseArgs(["-h", "-c", "sha1", "-p", "10", "-e", "prod", "-t", "hotfix"]);
    expect(parsed.help).toBe(true);
    expect(parsed.commit).toBe("sha1");
    expect(parsed.pr).toBe(10);
    expect(parsed.environment).toBe("prod");
    expect(parsed.deployType).toBe("HOTFIX");
  });

  it("handles empty or unknown flags gracefully", () => {
    const parsed = parseArgs(["--unknown-flag"]);
    expect(parsed.commit).toBeUndefined();
  });
});

describe("CLI script verify-deploy-pr - getFallbackCommit", () => {
  const oldSha = process.env.GITHUB_SHA;

  afterEach(() => {
    if (oldSha !== undefined) {
      process.env.GITHUB_SHA = oldSha;
    } else {
      delete process.env.GITHUB_SHA;
    }
  });

  it("uses GITHUB_SHA environment variable if available", () => {
    process.env.GITHUB_SHA = "env_commit_sha";
    expect(getFallbackCommit()).toBe("env_commit_sha");
  });

  it("returns non-empty string or fallback when GITHUB_SHA is unset", () => {
    delete process.env.GITHUB_SHA;
    const commit = getFallbackCommit();
    expect(typeof commit).toBe("string");
  });
});

describe("CLI script verify-deploy-pr - main function", () => {
  let tempDir: string;
  let ledgerPath: string;
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrSpy: ReturnType<typeof jest.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
    ledgerPath = path.join(tempDir, "ledger.json");

    originalFetch = globalThis.fetch;

    stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();

    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 0 for --help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("SOC2 Change-Management"));
  });

  it("returns 1 if commit cannot be resolved", async () => {
    const oldSha = process.env.GITHUB_SHA;
    delete process.env.GITHUB_SHA;

    const code = await main(["--commit", ""]);
    expect(code).toBe(1);

    if (oldSha !== undefined) {
      process.env.GITHUB_SHA = oldSha;
    }
  });

  it("returns 0 when deploy verification succeeds with merged PR", async () => {
    globalThis.fetch = jest.fn<typeof globalThis.fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        number: 520,
        title: "PR 520",
        merged: true,
      }),
    } as Response);

    process.env.GITHUB_TOKEN = "test_token";

    const code = await main([
      "--commit",
      "commit520",
      "--pr",
      "520",
      "--ledger-path",
      ledgerPath,
    ]);

    expect(code).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("DEPLOY APPROVED"));

    delete process.env.GITHUB_TOKEN;
  });

  it("returns 1 when deploy is blocked", async () => {
    const code = await main(["--commit", "unmerged_commit", "--ledger-path", ledgerPath]);
    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("DEPLOY BLOCKED"));
  });

  it("returns 2 when deploy is overridden", async () => {
    const code = await main([
      "--commit",
      "override_commit",
      "--override",
      "--override-reason",
      "Emergency patch",
      "--ledger-path",
      ledgerPath,
    ]);

    expect(code).toBe(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("DEPLOY OVERRIDDEN"));
  });

  it("outputs JSON when --json flag is passed", async () => {
    const code = await main([
      "--commit",
      "override_json",
      "--override",
      "--override-reason",
      "JSON test override",
      "--json",
      "--ledger-path",
      ledgerPath,
    ]);

    expect(code).toBe(2);
    const loggedOutput = consoleLogSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(loggedOutput)).not.toThrow();
  });

  it("outputs JSON error when --json is used with failing options", async () => {
    const code = await main([
      "--commit",
      "err_commit",
      "--override",
      "--json",
      "--ledger-path",
      ledgerPath,
    ]);

    expect(code).toBe(1);
    const loggedOutput = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(loggedOutput);
    expect(parsed.approved).toBe(false);
    expect(parsed.error).toContain("Override requires a non-empty override reason");
  });

  it("handles unexpected errors during verification (e.g. override without reason)", async () => {
    const code = await main([
      "--commit",
      "err_commit",
      "--override",
      "--ledger-path",
      ledgerPath,
    ]);

    expect(code).toBe(1);
    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("Error during deploy verification"));
  });
});

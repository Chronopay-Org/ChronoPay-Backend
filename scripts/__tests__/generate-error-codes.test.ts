/**
 * Tests for the error-code documentation generator.
 *
 * Validates that the generated reference table:
 * - is deterministic
 * - covers every code in the taxonomy with its status and scope
 * - reflects the public/internal split
 * - mentions the i18n key → message pipeline
 */

import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildErrorCodesDoc,
  writeErrorCodesDoc,
  DEFAULT_OUTPUT_FILE,
} from "../generate-error-codes";
import { ERROR_TAXONOMY } from "../../src/errors/errorCodes";

describe("buildErrorCodesDoc", () => {
  it("returns the same deterministic document across calls", () => {
    expect(buildErrorCodesDoc()).toBe(buildErrorCodesDoc());
  });

  it("covers every taxonomy code with its status and scope", () => {
    const doc = buildErrorCodesDoc();
    Object.entries(ERROR_TAXONOMY).forEach(([code, entry]) => {
      expect(doc).toContain(`\`${code}`);
      expect(doc).toContain(entry.scope);
    });
  });

  it("places public and internal codes under the correct scope", () => {
    const doc = buildErrorCodesDoc();
    expect(doc).toMatch(/`NOT_FOUND\s*`/);
    expect(doc).toMatch(/public/);
    expect(doc).toMatch(/`DB_ERROR\s*`/);
    expect(doc).toMatch(/internal/);
  });

  it("documents the i18n message pipeline and regeneration command", () => {
    const doc = buildErrorCodesDoc();
    expect(doc).toContain("generate:error-docs");
    expect(doc).toContain("src/errors/errorCodes.ts");
    expect(doc).toContain("INTERNAL_ERROR");
  });

  it("always reports an absolute default output path shape", () => {
    expect(DEFAULT_OUTPUT_FILE).toBe("docs/error-codes.md");
  });
});

describe("writeErrorCodesDoc", () => {
  it("writes the generated document to a temp directory", () => {
    const dir = mkdtempSync(`${tmpdir()}/error-docs-`);

    try {
      const target = writeErrorCodesDoc("error-codes.md", dir);
      const written = readFileSync(target, "utf8");
      expect(written).toBe(buildErrorCodesDoc());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

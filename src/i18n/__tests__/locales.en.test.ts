/**
 * Focused coverage for src/i18n/locales.en.ts (`EN_MESSAGES`).
 *
 * The English catalog is the source of truth for every user-facing error
 * message and the fallback target for every other locale, so the suite asserts
 * two things that a type-checker cannot: that every leaf is a real, non-empty
 * string, and that the catalog stays structurally in sync with the Spanish one
 * and with every message key declared in the error taxonomy.
 */

import { describe, it, expect } from "@jest/globals";
import { EN_MESSAGES } from "../locales.en.js";
import { ES_MESSAGES } from "../locales.es.js";
import { resolveMessage } from "../messageLoader.js";
import { ERROR_TAXONOMY } from "../../errors/errorCodes.js";
import type { I18nMessageKey } from "../../errors/errorCodes.js";

type Nested = { [key: string]: string | Nested };

/** Collect every dotted path that terminates in a string leaf. */
function leafPaths(node: Nested, prefix = ""): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : leafPaths(value, path);
  });
}

function leafValue(node: Nested, path: string): string {
  return path.split(".").reduce<unknown>(
    (acc, segment) => (acc as Record<string, unknown>)[segment],
    node,
  ) as string;
}

const en = EN_MESSAGES as unknown as Nested;
const es = ES_MESSAGES as unknown as Nested;

const taxonomyKeys = Object.entries(ERROR_TAXONOMY)
  .map(([, entry]) => (entry as { messageKey?: string }).messageKey)
  .filter((key): key is string => typeof key === "string");

// ─── Catalog shape ───────────────────────────────────────────────────────────

describe("EN_MESSAGES — catalog shape", () => {
  it("is not empty", () => {
    expect(leafPaths(en).length).toBeGreaterThan(0);
  });

  it("only exposes non-empty, trimmed string leaves", () => {
    for (const path of leafPaths(en)) {
      const value = leafValue(en, path);
      expect(typeof value).toBe("string");
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).toBe(value.trim());
    }
  });

  it("never leaks a placeholder equal to its own key", () => {
    for (const path of leafPaths(en)) {
      expect(leafValue(en, path)).not.toBe(path);
    }
  });

  it("keeps the same key structure as the Spanish catalog", () => {
    expect(leafPaths(en).sort()).toEqual(leafPaths(es).sort());
  });
});

// ─── Taxonomy contract ───────────────────────────────────────────────────────

describe("EN_MESSAGES — error taxonomy contract", () => {
  it("declares at least one message key in the taxonomy", () => {
    expect(taxonomyKeys.length).toBeGreaterThan(0);
  });

  it("resolves every taxonomy message key in English (no key fallbacks)", () => {
    for (const key of taxonomyKeys) {
      expect(resolveMessage(key as I18nMessageKey, "en")).not.toBe(key);
    }
  });

  it("resolves every taxonomy message key in Spanish", () => {
    for (const key of taxonomyKeys) {
      expect(resolveMessage(key as I18nMessageKey, "es")).not.toBe(key);
    }
  });

  it("defaults to English when no locale is supplied", () => {
    const key = "errors.validation.bad_request" as I18nMessageKey;
    expect(resolveMessage(key)).toBe("Bad Request");
  });
});

// ─── Representative values ───────────────────────────────────────────────────

describe("EN_MESSAGES — representative values", () => {
  it("carries the expected copy for critical error keys", () => {
    expect(resolveMessage("errors.validation.bad_request" as I18nMessageKey, "en")).toBe(
      "Bad Request",
    );
    expect(resolveMessage("errors.auth.unauthorized" as I18nMessageKey, "en")).toBe(
      "Unauthorized",
    );
    expect(resolveMessage("errors.authz.forbidden" as I18nMessageKey, "en")).toBe("Forbidden");
    expect(resolveMessage("errors.internal.internal_error" as I18nMessageKey, "en")).toBe(
      "Internal server error",
    );
  });

  it("falls back to the requested key when a message is unknown", () => {
    const unknown = "errors.does_not_exist.ever" as I18nMessageKey;
    expect(resolveMessage(unknown, "en")).toBe(unknown);
    expect(resolveMessage(unknown, "es")).toBe(unknown);
  });
});

/**
 * i18n message loader for error codes.
 *
 * Provides localized error messages indexed by i18n keys.
 * Supports multiple languages with a configurable fallback chain.
 */

import type { I18nMessageKey } from "../errors/errorTaxonomy.js";
import { EN_MESSAGES } from "./locales.en.js";
import { ES_MESSAGES } from "./locales.es.js";

export type SupportedLocale = "en" | "es";

/**
 * Message catalog type: nested object matching locales.ts structure.
 */
export type MessageCatalog = typeof EN_MESSAGES;

/**
 * Locale-indexed catalog of messages.
 */
const LOCALE_CATALOGS: Record<SupportedLocale, MessageCatalog> = {
  en: EN_MESSAGES,
  es: ES_MESSAGES,
};

/**
 * Resolve a message by its i18n key, with fallback chain.
 *
 * @param key - i18n key (e.g., "errors.validation.bad_request")
 * @param locale - target locale, defaults to "en"
 * @returns localized message string, or key itself if not found
 *
 * @example
 * resolveMessage("errors.validation.bad_request", "es")
 * // => "Solicitud inválida"
 */
export function resolveMessage(
  key: I18nMessageKey,
  locale: SupportedLocale = "en",
): string {
  // Attempt to resolve in target locale
  const resolved = resolveInLocale(key, locale);
  if (resolved) {
    return resolved;
  }

  // Fallback to English
  if (locale !== "en") {
    const fallback = resolveInLocale(key, "en");
    if (fallback) {
      return fallback;
    }
  }

  // Last resort: return key itself (for testing and visibility)
  return String(key);
}

/**
 * Internal: resolve message within a single locale.
 */
function resolveInLocale(
  key: I18nMessageKey,
  locale: SupportedLocale,
): string | undefined {
  const catalog = LOCALE_CATALOGS[locale];
  if (!catalog) {
    return undefined;
  }

  // Navigate nested object using dot-notation key
  const keys = String(key).split(".");
  let current: any = catalog;

  for (const k of keys) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = current[k];
  }

  return typeof current === "string" ? current : undefined;
}

/**
 * Typed getter for message catalogs.
 * Validates locale at runtime.
 */
export function getMessageCatalog(locale: SupportedLocale): MessageCatalog {
  const catalog = LOCALE_CATALOGS[locale];
  if (!catalog) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  return catalog;
}

/**
 * List all supported locales.
 */
export function getSupportedLocales(): SupportedLocale[] {
  return Object.keys(LOCALE_CATALOGS) as SupportedLocale[];
}

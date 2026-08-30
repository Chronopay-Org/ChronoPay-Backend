/**
 * i18n message loader for error codes.
 *
 * Provides localized error messages indexed by i18n keys with a configurable
 * fallback chain (requested locale → English → the key itself). Keys are typed
 * via `I18nMessageKey` from the error taxonomy so message resolution is
 * compile-time safe at the taxonomy boundary.
 */

import type { I18nMessageKey } from "../errors/errorCodes.js";
import { EN_MESSAGES } from "./locales.en.js";
import { ES_MESSAGES } from "./locales.es.js";

export type SupportedLocale = "en" | "es";

/**
 * Message catalog type: nested object matching the locale file structure.
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
 * @param key - i18n key (e.g. "errors.validation.bad_request")
 * @param locale - target locale, defaults to "en"
 * @returns the localized message, or the key itself when not found
 *
 * @example
 * resolveMessage("errors.validation.bad_request", "es")
 * // => "Solicitud inválida"
 */
export function resolveMessage(key: I18nMessageKey, locale: SupportedLocale = "en"): string {
  // Attempt to resolve in the target locale.
  const resolved = resolveInLocale(String(key), LOCALE_CATALOGS[locale]);
  if (resolved) {
    return resolved;
  }

  // Fallback to English.
  if (locale !== "en") {
    const fallback = resolveInLocale(String(key), LOCALE_CATALOGS.en);
    if (fallback) {
      return fallback;
    }
  }

  // Last resort: return the key itself (for testing and visibility).
  return String(key);
}

/**
 * Internal: resolve a dotted key within a single message catalog.
 */
function resolveInLocale(key: string, catalog: MessageCatalog): string | undefined {
  const keys = key.split(".");
  let current: unknown = catalog;

  for (const segment of keys) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    const next = (current as Record<string, unknown>)[segment];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }

  return typeof current === "string" ? current : undefined;
}

/**
 * Typed getter for message catalogs. Validates the locale at runtime.
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

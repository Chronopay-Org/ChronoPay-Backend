import { describe, expect, it } from '@jest/globals';
import {
  getMessageCatalog,
  getSupportedLocales,
  resolveMessage,
  type SupportedLocale,
} from '../messageLoader.js';

describe('messageLoader focused regression behavior', () => {
  it('returns supported locales and resolves a normal message', () => {
    expect(getSupportedLocales()).toEqual(['en', 'es']);
    expect(resolveMessage('errors.validation.bad_request' as never, 'en')).not.toBe(
      'errors.validation.bad_request',
    );
  });

  it('returns the key for missing and empty-result paths', () => {
    expect(resolveMessage('errors.not_present' as never, 'es')).toBe('errors.not_present');
    expect(resolveMessage('errors.validation' as never, 'en')).toBe('errors.validation');
    expect(resolveMessage('errors.validation.bad_request.extra' as never, 'en')).toBe(
      'errors.validation.bad_request.extra',
    );
  });

  it('throws for unsupported catalog locales while preserving supported catalogs', () => {
    expect(getMessageCatalog('es')).toBeDefined();
    expect(() => getMessageCatalog('fr' as SupportedLocale)).toThrow('Unsupported locale: fr');
  });
});

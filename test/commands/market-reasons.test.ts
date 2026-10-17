import { describe, expect, it } from 'vitest';
import { reasonId, reasonText } from '../../src/commands/catalog-market.js';
import { ERROR_CODES } from '../../src/market/protocol.js';
import { withLang } from '../helpers.js';

describe('marketplace error reasons', () => {
  it('every protocol error code has its own message', () => {
    for (const code of ERROR_CODES) expect(reasonId(code), code).toBe(`market.error.${code}`);
    expect(reasonId('weird')).toBe('market.error.unknown');
  });

  it('sign-in and moderation codes read well in English and Turkish', () => {
    expect(reasonText('not-admin')).toBe('Only marketplace admins can do this');
    expect(reasonText('unavailable')).toBe('Sign-in is not set up on this marketplace yet');
    expect(reasonText('forbidden')).toContain('waits until an admin approves your next entry');
    withLang('tr', () => {
      expect(reasonText('banned')).toBe('Bu marketplace hesabı yasaklandı');
      expect(reasonText('unavailable')).toBe("Bu marketplace'te giriş henüz ayarlanmamış");
      expect(reasonText('upstream')).toBe('Giriş hizmeti (GitHub) kullanılamıyor; daha sonra tekrar deneyin');
    });
  });
});

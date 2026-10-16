import { describe, expect, it } from 'vitest';
import { t } from '../../src/core/i18n/index.js';
import { brewHint, canSelfUpdate, kindLabel, updateCommand } from '../../src/editor/web/update-info.js';
import { withLang } from '../helpers.js';

describe('web update info', () => {
  it('labels install kinds', () => {
    expect(kindLabel('brew')).toBe(t('update.kindBrew'));
    expect(kindLabel('brew')).toBe('Homebrew install');
    expect(kindLabel('npm-global')).toBe('global npm install');
    expect(kindLabel('local')).toBe('pinned copy in your config folder');
    expect(kindLabel('npx')).toBe('running through npx');
    expect(kindLabel('source')).toBe('source checkout');
    expect(kindLabel(undefined)).toBe('unknown install');
    expect(kindLabel('weird')).toBe('weird');
    expect(kindLabel('toString')).toBe('toString');
  });

  it('labels a brew copy in Turkish', () => {
    expect(withLang('tr', () => kindLabel('brew'))).toBe('Homebrew kurulumu');
  });

  it('offers a self-update only to npm copies', () => {
    expect(canSelfUpdate('npm-global')).toBe(true);
    expect(canSelfUpdate('local')).toBe(true);
    for (const k of ['brew', 'npx', 'source', 'unknown', undefined]) expect(canSelfUpdate(k)).toBe(false);
  });

  it('names the brew upgrade command', () => {
    expect(updateCommand('brew')).toBe('brew upgrade ccinfobar');
    expect(updateCommand('npm-global')).toBeNull();
    expect(updateCommand(undefined)).toBeNull();
  });

  it('shows the brew hint unless updates are off', () => {
    const hint =
      'Homebrew updates this copy: run `brew upgrade ccinfobar`. "Install automatically" acts like "Tell me"; ccinfobar never installs it.';
    expect(brewHint('brew', 'auto')).toBe(hint);
    expect(brewHint('brew', 'notify')).toBe(hint);
    expect(brewHint('brew', 'off')).toBeNull();
    expect(brewHint('npm-global', 'auto')).toBeNull();
    expect(withLang('tr', () => brewHint('brew', 'auto'))).toBe(
      'Bu kopyayı Homebrew güncelliyor: `brew upgrade ccinfobar` çalıştırın. "Otomatik kur", "Haber ver" gibi davranır; ccinfobar kendisi kurmaz.',
    );
  });
});

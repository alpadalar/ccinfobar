import { BREW_UPGRADE } from '../../core/brew.js';
import { type MessageId, t } from '../../core/i18n/index.js';

const KIND: Record<string, MessageId> = {
  'npm-global': 'web.kind.npm-global',
  local: 'web.kind.local',
  npx: 'web.kind.npx',
  source: 'web.kind.source',
  unknown: 'web.kind.unknown',
  brew: 'update.kindBrew',
};

export function kindLabel(kind: string | undefined): string {
  const k = kind ?? 'unknown';
  return Object.hasOwn(KIND, k) ? t(KIND[k]!) : k;
}

export function canSelfUpdate(kind: string | undefined): boolean {
  return kind === 'npm-global' || kind === 'local';
}

export function updateCommand(kind: string | undefined): string | null {
  return kind === 'brew' ? BREW_UPGRADE : null;
}

// off never checks, so no hint
export function brewHint(kind: string | undefined, update: string | undefined): string | null {
  const command = updateCommand(kind);
  return command && update !== 'off' ? t('update.brewSettingsHint', { command }) : null;
}

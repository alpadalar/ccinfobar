import { activeLanguage, type MessageId, t, withLanguage } from './index.js';
import type { CatalogMeta } from './types.js';

type Source = { source?: string };

function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
  return rec && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function catalog(): CatalogMeta | undefined {
  return activeLanguage().meta?.catalog;
}

export function themeDescription(theme: { id: string; description: string } & Source): string {
  if (theme.source === 'user') return theme.description;
  return own(catalog()?.themes, theme.id)?.description ?? theme.description;
}

export function styleText(
  style: { id: string; name: string; description: string },
  field: 'name' | 'description',
): string {
  return own(catalog()?.styles, style.id)?.[field] ?? style[field];
}

export function presetText(
  preset: { id: string; name: string; description: string } & Source,
  field: 'name' | 'description',
): string {
  if (preset.source === 'user') return preset[field];
  return own(catalog()?.presets, preset.id)?.[field] ?? preset[field];
}

export function bundleText(
  b: { id: string; name: string; description: string },
  field: 'name' | 'description',
): string {
  return own(catalog()?.bundles, b.id)?.[field] ?? b[field];
}

export function scenarioText(
  s: { id: string; label: string; description: string },
  field: 'label' | 'description',
): string {
  return own(catalog()?.scenarios, s.id)?.[field] ?? s[field];
}

export function styleGroupName(group: { id: string; name: string }): string {
  return own(catalog()?.styleGroups, group.id) ?? group.name;
}

const PRESET_LABELS: readonly MessageId[] = [
  'preset.label.elapsed',
  'preset.label.fiveHour',
  'preset.label.weekly',
];

// the server sends built-in presets with English labels
export function presetLabels<C extends { lines: { label?: string }[][] }>(config: C): C {
  const map = new Map(PRESET_LABELS.map((id) => [withLanguage('en', () => t(id)), t(id)]));
  const lines = config.lines.map((line) =>
    line.map((item) => {
      const label = item.label === undefined ? undefined : map.get(item.label);
      return label === undefined ? item : { ...item, label };
    }),
  );
  return { ...config, lines };
}

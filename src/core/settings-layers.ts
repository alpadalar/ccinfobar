export type LayerName = 'user' | 'project' | 'local' | 'managed';

export interface SettingsLayer {
  name: LayerName;
  file: string;
  data: Record<string, unknown> | null;
}

export const LAYER_ORDER = ['managed', 'local', 'project', 'user'] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// highest priority first; later managed files override earlier ones
export function priorityOrder(layers: SettingsLayer[]): SettingsLayer[] {
  const out: SettingsLayer[] = [];
  for (const name of LAYER_ORDER) {
    const same = layers.filter((l) => l.name === name);
    out.push(...(name === 'managed' ? same.reverse() : same));
  }
  return out;
}

export function effectiveObject(
  layers: SettingsLayer[],
  key: string,
): { value: Record<string, unknown>; layer: SettingsLayer } | null {
  for (const layer of priorityOrder(layers)) {
    const v = layer.data?.[key];
    if (isObj(v)) return { value: v, layer };
  }
  return null;
}

export function effectiveLeaf(
  layers: SettingsLayer[],
  path: string[],
): { value: boolean; layer: SettingsLayer } | null {
  for (const layer of priorityOrder(layers)) {
    let v: unknown = layer.data;
    for (const k of path) v = isObj(v) ? v[k] : undefined;
    if (typeof v === 'boolean') return { value: v, layer };
  }
  return null;
}

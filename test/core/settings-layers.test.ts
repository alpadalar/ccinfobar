import { describe, expect, it } from 'vitest';
import {
  effectiveLeaf,
  effectiveObject,
  LAYER_ORDER,
  priorityOrder,
  type SettingsLayer,
} from '../../src/core/settings-layers.js';

const L = (
  name: SettingsLayer['name'],
  data: Record<string, unknown> | null,
  file?: string,
): SettingsLayer => ({
  name,
  file: file ?? `/${name}.json`,
  data,
});

describe('LAYER_ORDER', () => {
  it('is managed, local, project, user', () => {
    expect([...LAYER_ORDER]).toEqual(['managed', 'local', 'project', 'user']);
  });
});

describe('effectiveObject', () => {
  const sl = (command: string) => ({ statusLine: { command } });
  it('project beats user, local beats project, managed beats all', () => {
    const user = L('user', sl('u'));
    const project = L('project', sl('p'));
    const local = L('local', sl('l'));
    const managed = L('managed', sl('m'));
    expect(effectiveObject([user], 'statusLine')?.layer.name).toBe('user');
    expect(effectiveObject([user, project], 'statusLine')?.layer.name).toBe('project');
    expect(effectiveObject([user, project, local], 'statusLine')?.layer.name).toBe('local');
    expect(effectiveObject([user, project, local, managed], 'statusLine')?.value).toEqual({ command: 'm' });
  });
  it('skips non-object values', () => {
    const layers = [
      L('user', sl('u')),
      L('project', { statusLine: 'x' }),
      L('local', { statusLine: null }),
      L('managed', { statusLine: [1] }),
    ];
    expect(effectiveObject(layers, 'statusLine')?.layer.name).toBe('user');
    expect(effectiveObject([L('user', {}), L('project', null)], 'statusLine')).toBeNull();
  });
  it('last managed file wins and a managed file without the key does not shadow', () => {
    const a = L('managed', sl('a'), '/m/managed-settings.json');
    const b = L('managed', sl('b'), '/m/managed-settings.d/b.json');
    const c = L('managed', {}, '/m/managed-settings.d/c.json');
    expect(effectiveObject([a, b], 'statusLine')?.layer.file).toBe('/m/managed-settings.d/b.json');
    expect(effectiveObject([a, b, c], 'statusLine')?.layer.file).toBe('/m/managed-settings.d/b.json');
    expect(effectiveObject([a, c], 'statusLine')?.layer.file).toBe('/m/managed-settings.json');
  });
});

describe('effectiveLeaf', () => {
  const path = ['sandbox', 'enabled'];
  const sb = (v: unknown) => ({ sandbox: { enabled: v } });
  it('follows the layer order', () => {
    expect(effectiveLeaf([L('user', sb(true))], path)).toMatchObject({ value: true });
    expect(effectiveLeaf([L('user', sb(true)), L('project', sb(false))], path)).toMatchObject({
      value: false,
      layer: { name: 'project' },
    });
    expect(
      effectiveLeaf([L('project', sb(false)), L('local', sb(true)), L('user', sb(false))], path)?.layer.name,
    ).toBe('local');
    expect(effectiveLeaf([L('local', sb(true)), L('managed', sb(false))], path)).toMatchObject({
      value: false,
      layer: { name: 'managed' },
    });
  });
  it('skips non-booleans and missing paths', () => {
    expect(
      effectiveLeaf([L('user', sb(true)), L('project', sb('true')), L('local', sb(1))], path),
    ).toMatchObject({
      layer: { name: 'user' },
    });
    expect(effectiveLeaf([L('user', {})], path)).toBeNull();
    expect(effectiveLeaf([L('user', { sandbox: 3 })], path)).toBeNull();
  });
  it('last managed file wins', () => {
    const a = L('managed', sb(true), '/m/managed-settings.json');
    const b = L('managed', sb(false), '/m/managed-settings.d/b.json');
    expect(effectiveLeaf([a, b], path)).toMatchObject({ value: false, layer: { file: b.file } });
  });
  it('resolves a three-deep path', () => {
    const data = { sandbox: { network: { allowManagedDomainsOnly: true } } };
    expect(effectiveLeaf([L('user', data)], ['sandbox', 'network', 'allowManagedDomainsOnly'])?.value).toBe(
      true,
    );
  });
  it('skips unreadable layers', () => {
    expect(effectiveLeaf([L('managed', null), L('user', sb(true))], path)?.layer.name).toBe('user');
  });
});

describe('priorityOrder', () => {
  it('lists managed last file first, then local, project, user', () => {
    const files = priorityOrder([
      L('user', {}, 'u'),
      L('project', {}, 'p'),
      L('managed', {}, 'm1'),
      L('local', {}, 'l'),
      L('managed', {}, 'm2'),
    ]).map((l) => l.file);
    expect(files).toEqual(['m2', 'm1', 'l', 'p', 'u']);
  });
});

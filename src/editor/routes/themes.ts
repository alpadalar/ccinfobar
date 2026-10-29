import { themeFromConfig } from '../../catalog/snapshot.js';
import { normalizeConfig } from '../../core/config.js';
import { applyStyle } from '../../core/edit.js';
import { withLanguage } from '../../core/i18n/index.js';
import { ID_RE, reservedId } from '../../core/ids.js';
import { deleteUserPreset, listPresets, saveUserPreset } from '../../core/presets.js';
import { renderPreview } from '../../core/preview.js';
import { withoutRotation } from '../../core/rotation.js';
import { deleteUserTheme, listThemes, parseThemeInput, saveUserTheme } from '../../core/themes.js';
import type { Config, WidgetItem } from '../../core/types.js';
import type { ExactRoute, PrefixRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import { asObject, httpError, previewSourceOf, readBody, send } from './util.js';

const DEMO_TYPES = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'];

export const prefix: PrefixRoute<EditorCtx>[] = [
  {
    methods: ['DELETE'],
    path: '/api/presets/',
    handler: async (ctx, _req, res, url) => {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/presets/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw httpError(400, 'err.server.badPresetId');
      if (listPresets().find((p) => p.id === id)?.source !== 'user')
        throw httpError(404, 'err.server.notUserPreset');
      deleteUserPreset(id);
      send(res, 200, { ok: true, presets: ctx.presetList() });
      return;
    },
  },
  {
    methods: ['DELETE'],
    path: '/api/themes/',
    handler: async (_ctx, _req, res, url) => {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/themes/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw httpError(400, 'err.server.badThemeId');
      const theme = listThemes().find((t) => t.id === id);
      if (theme?.source !== 'user') throw httpError(404, 'err.server.notUserTheme');
      deleteUserTheme(id);
      send(res, 200, { ok: true, themes: listThemes() });
      return;
    },
  },
];

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'POST',
    path: '/api/theme-previews',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const config = normalizeConfig(body.config);
      if (config.colorLevel === 'auto') config.colorLevel = 3;
      const source = previewSourceOf(body);
      const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
      const own = config.lines.find((l) => l.length > 0);
      const plain = own
        ? applyStyle(
            { ...config, lines: [own] },
            own.map((i) => i.id),
            {},
            ['colors', 'text'],
          ).lines[0]
        : null;
      const demo: WidgetItem[] = plain ?? DEMO_TYPES.map((type, i) => ({ id: `${type}-${i + 1}`, type }));
      const previews: Record<string, string[]> = {};
      for (const t of listThemes()) {
        const cfg: Config = {
          ...config,
          theme: t.id,
          lines: [demo],
          style: undefined,
          separator: undefined,
          separatorColor: undefined,
          padding: undefined,
          glyphs: undefined,
          tui: undefined,
        };
        previews[t.id] = withLanguage(ctx.auto.id, () => renderPreview(withoutRotation(cfg), source, width));
      }
      send(res, 200, { previews });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/themes',
    handler: async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      let input = parseThemeInput(body.theme);
      if (body.fromConfig !== undefined && input.id && ID_RE.test(input.id)) {
        input = themeFromConfig(normalizeConfig(body.fromConfig), input.id, {
          name: input.name ?? input.id,
          description: input.description ?? '',
        });
      }
      if (!input.id || !ID_RE.test(input.id)) {
        throw httpError(400, 'err.theme.badId');
      }
      if (reservedId(input.id)) throw httpError(400, 'err.id.reserved', { id: input.id });
      if (input.extends !== undefined && !ID_RE.test(input.extends)) {
        throw httpError(400, 'err.server.badExtendsId');
      }
      saveUserTheme(input);
      send(res, 200, { ok: true, id: input.id, themes: listThemes() });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/presets',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const meta = asObject(body.preset);
      const id = typeof meta.id === 'string' ? meta.id : '';
      if (!ID_RE.test(id)) throw httpError(400, 'err.server.presetIdRule');
      if (reservedId(id)) throw httpError(400, 'err.id.reserved', { id });
      saveUserPreset({
        id,
        name: typeof meta.name === 'string' ? meta.name.slice(0, 64) : id,
        description: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
        config: body.config,
      });
      send(res, 200, { ok: true, presets: ctx.presetList() });
      return;
    },
  },
];

import fs from 'node:fs';
import { ConfigBrokenError, normalizeConfig, saveConfig } from '../../core/config.js';
import { upgradeOptions } from '../../core/edit.js';
import { withLanguage } from '../../core/i18n/index.js';
import { ID_RE } from '../../core/ids.js';
import { loadForUse } from '../../core/load.js';
import { lastPayloadPath, tildify } from '../../core/paths.js';
import { presetsDir } from '../../core/presets.js';
import { renderPreviewReport } from '../../core/preview.js';
import { scenarioList } from '../../core/scenarios.js';
import { listThemes, parseThemeInput, resolveThemeInput, STYLES, themesDir } from '../../core/themes.js';
import { ALL_WIDGETS, CATEGORIES } from '../../widgets/index.js';
import { SUBAGENT_FIELDS } from '../../widgets/shared.js';
import type { ExactRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import { asObject, claudeInfo, httpError, previewSourceOf, readBody, send, VERSION } from './util.js';

function widgetCatalog() {
  return ALL_WIDGETS.map((w) => ({
    type: w.type,
    name: w.name,
    category: w.category,
    description: w.description,
    label: w.label,
    icon: w.icon,
    color: w.color,
    options: w.options ?? [],
    sample: w.sample,
    hidden: w.hidden ?? false,
    timeBased: w.timeBased === true,
    hideWhenEmpty: w.hideWhenEmpty === true,
  }));
}

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'GET',
    path: '/api/ping',
    handler: async (_ctx, _req, res) => {
      send(res, 200, { ok: true });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/state',
    handler: async (ctx, _req, res) => {
      const loaded = loadForUse(ctx.opts.configPath, () => ctx.gsd);
      const config = upgradeOptions(loaded.config);
      send(res, 200, {
        version: VERSION,
        configPath: tildify(ctx.opts.configPath),
        configError: loaded.error ?? null,
        configIssue: loaded.issue ?? null,
        config,
        savedConfig: config,
        widgets: widgetCatalog(),
        categories: CATEGORIES,
        subagentFields: SUBAGENT_FIELDS,
        presets: ctx.presetList(),
        presetsDir: tildify(presetsDir()),
        styleHistory: ctx.readStyles(),
        gsdInstalled: ctx.gsd,
        themes: listThemes(),
        styles: STYLES,
        themesDir: tildify(themesDir()),
        claude: claudeInfo(ctx.state.command),
        hooks: await ctx.hooksInfo(ctx.state.command),
        hasLastPayload: fs.existsSync(lastPayloadPath()),
        scenarios: scenarioList(),
        terminal: ctx.opts.terminal ?? null,
        language: ctx.auto,
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/preview',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const config = normalizeConfig(body.config);
      if (config.colorLevel === 'auto') config.colorLevel = 3;
      const source = previewSourceOf(body);
      const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 130));
      const draft = body.theme === undefined ? undefined : parseThemeInput(body.theme);
      if (draft?.extends !== undefined && !ID_RE.test(draft.extends)) {
        throw httpError(400, 'err.server.badExtendsId');
      }
      const theme = draft ? resolveThemeInput(draft) : undefined;
      send(
        res,
        200,
        withLanguage(ctx.auto.id, () => renderPreviewReport(config, source, width, theme)),
      );
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/normalize',
    handler: async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      send(res, 200, { config: normalizeConfig(body.config) });
      return;
    },
  },
  {
    method: 'PUT',
    path: '/api/config',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const config = upgradeOptions(normalizeConfig(body.config));
      try {
        saveConfig(config, ctx.opts.configPath);
      } catch (err) {
        if (!(err instanceof ConfigBrokenError)) throw err;
        const { line, column, message } = err.issue;
        throw httpError(409, 'config.refuseBroken', { file: err.file }, { line, column, message });
      }
      send(res, 200, { ok: true, config });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/shutdown',
    handler: async (ctx, _req, res) => {
      send(res, 200, { ok: true });
      setTimeout(() => void ctx.close(), 50);
      return;
    },
  },
];

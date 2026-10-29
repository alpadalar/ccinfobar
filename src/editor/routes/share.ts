import { decodeShare, encodeShare } from '../../catalog/share-code.js';
import { installEntryTheme } from '../../catalog/store.js';
import { normalizeConfig } from '../../core/config.js';
import { MAX_CODE_CHARS } from '../../core/share-code.js';
import { listThemes } from '../../core/themes.js';
import type { ExactRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import { asObject, httpError, readBody, send } from './util.js';

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'POST',
    path: '/api/share',
    handler: async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const included = body.includeCommands === true;
      const r = encodeShare(normalizeConfig(body.config), { includeCommands: included, cols: body.cols });
      if (!r.ok) throw httpError(400, r.errorId, r.params);
      const pair = (x: { kind: string; target: string }) => ({ kind: x.kind, target: x.target });
      send(res, 200, {
        code: r.code,
        chars: r.chars,
        max: MAX_CODE_CHARS,
        included,
        targets: r.targets.map(pair),
        dropped: r.dropped.map(pair),
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/share/open',
    handler: async (_ctx, req, res) => {
      const r = decodeShare(asObject(await readBody(req)).code);
      if (!r.ok) throw httpError(400, r.errorId);
      send(res, 200, {
        code: r.code,
        content: r.content,
        cols: r.cols ?? null,
        targets: r.targets,
        unsafe: r.unsafe,
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/share/install-theme',
    handler: async (_ctx, req, res) => {
      // decoded again; the page's content is not trusted
      const r = decodeShare(asObject(await readBody(req)).code);
      if (!r.ok) throw httpError(400, r.errorId);
      const theme = r.content.theme ? installEntryTheme(r.content) : null;
      send(res, 200, { ok: true, theme, themes: listThemes() });
      return;
    },
  },
];

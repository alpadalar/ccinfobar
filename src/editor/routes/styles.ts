import type { StyleHistory } from '../../core/edit.js';
import { writeAtomic } from '../../data/store.js';
import type { ExactRoute } from '../router.js';
import type { EditorCtx } from './ctx.js';
import { asObject, readBody, send } from './util.js';

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'PUT',
    path: '/api/styles',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const history = asObject(body.history);
      const clean: StyleHistory = {};
      for (const [id, list] of Object.entries(history).slice(0, 500)) {
        if (Array.isArray(list))
          clean[id.slice(0, 80)] = list.filter((s) => s && typeof s === 'object').slice(0, 3);
      }
      writeAtomic(ctx.stylesFile, `${JSON.stringify(clean, null, 2)}\n`, { class: 'settings' });
      send(res, 200, { ok: true });
      return;
    },
  },
];

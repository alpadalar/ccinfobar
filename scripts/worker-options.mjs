import { builtinModules } from 'node:module';
import path from 'node:path';

// workerd runs without nodejs_compat
const builtins = new Set(builtinModules);

const noNode = {
  name: 'no-node',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.split('/')[0];
      if (args.path.startsWith('node:') || builtins.has(args.path) || builtins.has(bare)) {
        return { errors: [{ text: `node import in worker: ${args.path}` }] };
      }
      return undefined;
    });
  },
};

export function workerBuildOptions({ root, outfile, format = 'esm', globalName }) {
  return {
    entryPoints: [path.join(root, 'src/market/worker/index.ts')],
    bundle: true,
    format,
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    legalComments: 'none',
    minify: false,
    metafile: true,
    outfile,
    globalName,
    plugins: [noNode],
  };
}

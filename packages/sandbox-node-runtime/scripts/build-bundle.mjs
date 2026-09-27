import { build } from 'esbuild';

await build({
  entryPoints: ['src/invoke.ts'],
  outfile: 'dist/invoke.bundle.js',
  bundle: true,
  external: ['puppeteer-core'],
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  preserveSymlinks: true,
  minifyWhitespace: true,
});

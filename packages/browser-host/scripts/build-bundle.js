#!/usr/bin/env node
// Bundles the host and its shared browser_* contract into one file that runs under a plain
// installed `node`. puppeteer-core is bundled; no browser is bundled or downloaded.
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  outfile: process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', 'browser-host.bundle.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  legalComments: 'external',
  logLevel: 'info',
  // Page functions are serialized with Function.prototype.toString; never rename or wrap them.
  keepNames: false,
  minify: false,
});

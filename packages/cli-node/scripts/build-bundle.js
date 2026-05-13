#!/usr/bin/env node

const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  sourcesContent: false,
  legalComments: 'none',
  logLevel: 'info',
};

async function build() {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src', 'client.ts')],
    outfile: path.join(distDir, 'client.bundle.js'),
  });

  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src', 'tui.ts')],
    outfile: path.join(distDir, 'tui.bundle.js'),
  });
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

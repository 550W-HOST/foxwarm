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
  // The Code helper wrapper executes the shared module by its real filename.
  // Keep this one module outside the bundle so __filename points to
  // packages/shared/dist/codeHelperIpc.js rather than client.bundle.js.
  external: ['../../shared/dist/codeHelperIpc'],
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

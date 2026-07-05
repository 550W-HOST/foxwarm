#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const checks = [
  {
    label: 'root backend TypeScript unused check',
    args: ['--no-install', 'tsc', '-p', 'tsconfig.json', '--noEmit', '--noUnusedLocals', '--noUnusedParameters', '--pretty', 'false'],
  },
  {
    label: 'shared package TypeScript unused check',
    args: ['--no-install', 'tsc', '-p', 'packages/shared/tsconfig.json', '--noEmit', '--noUnusedLocals', '--noUnusedParameters', '--pretty', 'false'],
  },
  {
    label: 'cli-node package TypeScript unused check',
    args: ['--no-install', 'tsc', '-p', 'packages/cli-node/tsconfig.json', '--noEmit', '--noUnusedLocals', '--noUnusedParameters', '--pretty', 'false'],
  },
  {
    label: 'webui package TypeScript check (tsconfig already enables unused checks)',
    args: ['--no-install', 'tsc', '-p', 'packages/webui/tsconfig.json', '--noEmit', '--pretty', 'false'],
  },
];

for (const check of checks) {
  console.log(`\n[quality:unused] ${check.label}`);
  const result = spawnSync(npxBin, check.args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(`[quality:unused] Failed to run ${check.label}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[quality:unused] ${check.label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[quality:unused] All TypeScript unused checks passed.');
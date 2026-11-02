#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.dirname(__dirname);
const staging = path.join(root, 'build', 'core');
const runtime = path.join(root, 'runtime');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // npm is a command script on Windows; dotnet is an executable.
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}).`);
}

function promote(mainStopped) {
  if (!fs.existsSync(path.join(staging, 'Foxwarm.dll'))) {
    throw new Error('No staged Core build. Run `npm run build -- --stage-only` first.');
  }
  // Inspect with the candidate readers before selecting it. Warnings retain local
  // failures; global/active-Worker blockers leave the selected output untouched.
  run('dotnet', [path.join(staging, 'Foxwarm.dll'), '--installation-root', root, '--inspect-upgrade']);
  fs.mkdirSync(runtime, { recursive: true });
  const destination = path.join(runtime, `${Date.now()}-${randomUUID()}`);
  fs.renameSync(staging, destination);
  const current = path.join(runtime, 'current');
  try { fs.unlinkSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.symlinkSync(destination, current, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`Source runtime: ${destination}`);
  // A standalone build may run beside Main, which keeps using its resolved output.
  // The controls promote only after stopping Main; then the new output is the only
  // one in use and earlier outputs are removed.
  if (!mainStopped) return;
  for (const name of fs.readdirSync(runtime)) {
    const old = path.join(runtime, name);
    if (name === 'current' || old === destination) continue;
    // Windows refuses to rename a directory whose files a process still holds;
    // leave that output for a later promotion instead of deleting it partially.
    const retired = name.startsWith('.retired-') ? old : path.join(runtime, `.retired-${name}`);
    try {
      if (retired !== old) fs.renameSync(old, retired);
      fs.rmSync(retired, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Kept previous runtime ${old}: ${error.code || error.message}`);
    }
  }
}

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--install', '--stage-only', '--core-only', '--promote'].includes(arg))
      || (args.includes('--promote') && args.length !== 1)) {
    throw new Error('Usage: build-source.js [--install] [--stage-only] [--core-only] | --promote');
  }
  if (args.includes('--promote')) {
    promote(true);
  } else {
    // Every build, including the first one, uses disposable staging. Nothing in
    // runtime is compiled or copied over in place.
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      if (args.includes('--install')) {
        run('npm', ['ci']);
        run('npm', ['--prefix', 'packages/webui', 'ci']);
      }
      if (!args.includes('--core-only')) run('npm', ['run', 'build:assets']);
      // A source runtime only runs on this host; omit other platforms' native assets.
      run('dotnet', ['build', 'dotnet/Foxwarm/Foxwarm.csproj', '--use-current-runtime', '-o', staging,
        ...(!args.includes('--core-only') ? ['-p:FoxwarmDelivery=true'] : [])]);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    if (!args.includes('--stage-only')) promote(false);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

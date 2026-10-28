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

function promote() {
  if (!fs.existsSync(path.join(staging, 'Foxwarm.dll'))) {
    throw new Error('No staged Core build. Run `npm run build -- --stage-only` first.');
  }
  // Inspect with the candidate readers before selecting it. Warnings retain local
  // failures; global/active-Worker blockers leave the selected output untouched.
  run('dotnet', [path.join(staging, 'Foxwarm.dll'), '--installation-root', root, '--inspect-upgrade']);
  fs.mkdirSync(runtime, { recursive: true });
  const destination = path.join(runtime, `${Date.now()}-${randomUUID()}`);
  fs.renameSync(staging, destination);
  // Keep old directories at their original paths: detached exec scripts can call
  // their original managed helper after Main has stopped.
  const current = path.join(runtime, 'current');
  try { fs.unlinkSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.symlinkSync(destination, current, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`Source runtime: ${destination}`);
}

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--install', '--stage-only', '--core-only', '--promote'].includes(arg))
      || (args.includes('--promote') && args.length !== 1)) {
    throw new Error('Usage: build-source.js [--install] [--stage-only] [--core-only] | --promote');
  }
  if (args.includes('--promote')) {
    promote();
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
      run('dotnet', ['build', 'dotnet/Foxwarm/Foxwarm.csproj', '-o', staging,
        ...(!args.includes('--core-only') ? ['-p:FoxwarmDelivery=true'] : [])]);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    if (!args.includes('--stage-only')) promote();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

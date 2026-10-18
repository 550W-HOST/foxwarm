'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// One parsed-options header, optional prompt stdin and ordinary stdout/stderr.
// These operations never connect to Main or start a server or Session engine.
async function runCoreCli(operation, input, options = {}) {
  const root = path.dirname(__dirname);
  const published = fs.existsSync(path.join(root, 'Foxwarm.dll'));
  const assembly = published
    ? path.join(root, 'Foxwarm.dll')
    : path.join(root, 'dotnet', 'Foxwarm', 'bin', 'Debug', 'net10.0', 'Foxwarm.dll');
  if (!fs.existsSync(assembly)) {
    throw new Error('Foxwarm Core build output is missing. Run `npm run build` (requires the .NET 10 SDK) first.');
  }
  const apphost = path.join(root, process.platform === 'win32' ? 'Foxwarm.exe' : 'Foxwarm');
  const useApphost = published && fs.existsSync(apphost);
  const child = spawn(useApphost ? apphost : 'dotnet', [
    ...(useApphost ? [] : [assembly]), `--cli-${operation}`,
  ], {
    env: { ...process.env, FOXWARM_APP_ROOT: process.env.FOXWARM_APP_ROOT || root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  child.stdout.on('data', chunk => stdout.write(chunk));
  child.stderr.on('data', chunk => stderr.write(chunk));
  child.stdin.write(JSON.stringify(input) + '\n');
  const stdin = options.stdin || process.stdin;
  if (operation === 'model' && input.prompt === undefined && !input.list && !stdin.isTTY) {
    stdin.pipe(child.stdin);
    child.once('close', () => stdin.unpipe(child.stdin));
  } else child.stdin.end();
  return await new Promise((resolve, reject) => {
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', error => reject(new Error(`Cannot launch Foxwarm Core: ${error.message}. Install the .NET 10 runtime or make dotnet available on PATH.`)));
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Foxwarm Core terminated by ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

module.exports = { runCoreCli };

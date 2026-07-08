#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const defaultOutDir = path.join(packageRoot, 'assets', 'vscode-web');

function parseArgs(argv) {
  const result = { quality: 'stable', outDir: defaultOutDir, commit: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--quality=')) {
      result.quality = arg.slice('--quality='.length);
    } else if (arg.startsWith('--commit=')) {
      result.commit = arg.slice('--commit='.length);
    } else if (arg.startsWith('--out=')) {
      result.outDir = path.resolve(arg.slice('--out='.length));
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/prepare-assets.mjs [--quality=stable|insiders] [--commit=<sha>] [--out=<dir>]\n\nDownloads official VS Code web-standalone assets without committing them.\nDefault output: ${defaultOutDir}`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (result.quality !== 'stable' && result.quality !== 'insiders') {
    throw new Error('--quality must be stable or insiders');
  }
  return result;
}

async function getDownloadInfo(quality, commit) {
  if (!commit) {
    const response = await fetch(`https://update.code.visualstudio.com/api/update/web-standalone/${quality}/latest`);
    if (!response.ok) {
      throw new Error(`Failed to query latest ${quality} VS Code Web build: HTTP ${response.status}`);
    }
    const info = await response.json();
    return { url: info.url, version: info.version };
  }

  const response = await fetch(`https://update.code.visualstudio.com/commit:${commit}/web-standalone/${quality}`, {
    method: 'HEAD',
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`Failed to resolve VS Code Web download for ${quality} commit ${commit}: HTTP ${response.status}`);
  }
  return { url: location, version: commit };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: options.stdio ?? 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}`));
      }
    });
  });
}

function pipeDownloadToTar(url, destination) {
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['--fail', '--location', '--show-error', '--progress-bar', url], { stdio: ['ignore', 'pipe', 'inherit'] });
    const tar = spawn('tar', ['-xz', '-C', destination, '--strip-components=1'], { stdio: ['pipe', 'inherit', 'inherit'] });

    curl.stdout.pipe(tar.stdin);

    let curlDone = false;
    let tarDone = false;
    let failed = false;

    function fail(error) {
      if (!failed) {
        failed = true;
        curl.kill('SIGTERM');
        tar.kill('SIGTERM');
        reject(error);
      }
    }

    function maybeDone() {
      if (!failed && curlDone && tarDone) {
        resolve();
      }
    }

    curl.on('error', fail);
    tar.on('error', fail);
    curl.on('exit', (code, signal) => {
      curlDone = true;
      if (code !== 0) {
        fail(new Error(`curl exited with ${code ?? signal}`));
      } else {
        maybeDone();
      }
    });
    tar.on('exit', (code, signal) => {
      tarDone = true;
      if (code !== 0) {
        fail(new Error(`tar exited with ${code ?? signal}`));
      } else {
        maybeDone();
      }
    });
  });
}

async function main() {
  const { quality, commit, outDir } = parseArgs(process.argv.slice(2));
  const info = await getDownloadInfo(quality, commit);
  const tmpDir = `${outDir}.tmp-${process.pid}`;

  console.log(`Downloading VS Code Web ${quality} ${info.version} to ${outDir}`);
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await pipeDownloadToTar(info.url, tmpDir);
  await fs.writeFile(path.join(tmpDir, 'foxwarm-vscode-web-assets.json'), JSON.stringify({ quality, version: info.version, source: info.url }, null, 2));
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await runProcess('mv', [tmpDir, outDir]);
  console.log(`Prepared VS Code Web assets at ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

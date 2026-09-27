import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { spawn } from 'child_process';
import { formatNodeProcessTitle } from './processTitle';

test('node process title keeps the role first and normalizes identity controls', () => {
  assert.equal(formatNodeProcessTitle(), 'foxwarm:node');
  assert.equal(formatNodeProcessTitle('worker-1'), 'foxwarm:node worker-1');
  assert.equal(formatNodeProcessTitle('worker\n1'), 'foxwarm:node worker 1');
});

test('importing the CLI client does not rename an embedding host', async () => {
  const sentinel = 'embedding-host';
  const clientPath = require.resolve('./client');
  const child = spawn(process.execPath, ['-e', [
    `process.title=${JSON.stringify(sentinel)};`,
    `require(${JSON.stringify(clientPath)});`,
    `process.stdout.write(process.title);`,
  ].join('')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, sentinel);
});

test('node title remains role-recognizable in Linux comm', {
  skip: process.platform !== 'linux',
}, async () => {
  const helperPath = require.resolve('./processTitle');
  const child = spawn(process.execPath, ['-e', [
    `require(${JSON.stringify(helperPath)}).setNodeProcessTitle('node-with-a-long-identity');`,
    `setTimeout(() => {}, 5000);`,
  ].join('')], { stdio: 'ignore' });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      setTimeout(resolve, 100);
    });
    const comm = fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim();
    const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    assert.ok(comm.startsWith('foxwarm:node'), `unexpected comm: ${comm}`);
    assert.match(cmdline, /^foxwarm:node node-with-a-long-identity(?:\s|$)/);
  } finally {
    child.kill('SIGKILL');
  }
});
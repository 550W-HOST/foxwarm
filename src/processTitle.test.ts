import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { spawn } from 'child_process';
import { formatFoxwarmProcessTitle, setFoxwarmProcessTitle } from './processTitle';

test('process title formatter keeps the role first and normalizes identity controls', () => {
  assert.equal(formatFoxwarmProcessTitle('main'), 'foxwarm:main');
  assert.equal(formatFoxwarmProcessTitle('vector'), 'foxwarm:vector');
  assert.equal(formatFoxwarmProcessTitle('session', 'agent/main\nchild'), 'foxwarm:session agent/main child');
});

test('setting a session process title remains role-recognizable in Linux comm', {
  skip: process.platform !== 'linux',
}, async () => {
  const child = spawn(process.execPath, ['-e', [
    `const { setFoxwarmProcessTitle } = require(${JSON.stringify(__filename.replace(/\.test\.js$/, '.js'))});`,
    `setFoxwarmProcessTitle('session', 'agent/main');`,
    `setTimeout(() => {}, 5000);`,
  ].join('')], { stdio: 'ignore' });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      setTimeout(resolve, 100);
    });
    const comm = fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim();
    const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    assert.equal(comm, 'foxwarm:session');
    assert.match(cmdline, /^foxwarm:session agent\/main(?:\s|$)/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('importing the process-title helper does not rename its host', () => {
  const before = process.title;
  void setFoxwarmProcessTitle;
  assert.equal(process.title, before);
});
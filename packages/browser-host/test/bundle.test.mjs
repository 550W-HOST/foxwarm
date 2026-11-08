import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserEnvironment, startSite } from './fixture.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = await browserEnvironment();

// The delivered artifact is a single file; page functions are serialized by source text, so the
// bundle itself must still read, fill and click.
test('the bundled host runs page operations from one file', { skip: environment.available ? false : environment.reason }, async () => {
  const out = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fw-host-bundle-')), 'host.cjs');
  execFileSync(process.execPath, [path.join(root, 'scripts/build-bundle.js'), out], { stdio: 'ignore' });
  const site = await startSite();
  const child = spawn(process.execPath, [out], { env: environment.env, stdio: ['pipe', 'pipe', 'inherit'], cwd: os.tmpdir() });
  const replies = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => replies.push(JSON.parse(line)));
  const ask = async (id, tool, args) => {
    child.stdin.write(JSON.stringify({ id, tool, args }) + '\n');
    for (let i = 0; i < 400 && !replies.some((reply) => reply.id === id); i++) await new Promise((r) => setTimeout(r, 50));
    const reply = replies.find((entry) => entry.id === id);
    assert.ok(reply?.ok, JSON.stringify(reply));
    return reply.result;
  };
  try {
    const { tabId } = await ask(1, 'browser_open', { url: site.url('/') });
    const shot = await ask(2, 'browser_read', { tabId });
    const ref = shot.elements.find((element) => element.label === 'Controlled').ref;
    await ask(3, 'browser_fill', { tabId, ref, text: 'bundled' });
    const mirror = await ask(4, 'browser_evaluate', { tabId, code: 'document.getElementById("mirror").textContent' });
    assert.equal(mirror.result, 'mirror:bundled');
    const clicked = await ask(5, 'browser_click', { tabId, selector: '#go' });
    assert.equal(clicked.navigated, true);
  } finally {
    child.stdin.end();
    await once(child, 'exit');
    await site.close();
  }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { browserEnvironment, startSite } from './fixture.mjs';

const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/main.js');
const environment = await browserEnvironment();
const skip = environment.available ? false : environment.reason;

function startHost(env = environment.env) {
  const child = spawn(process.execPath, [main], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  let next = 1;
  return {
    child,
    request(tool, args = {}, deadlineMs) {
      const id = next++;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(JSON.stringify({ id, tool, args, deadlineMs }) + '\n');
      return { id, reply };
    },
    cancel: (id) => child.stdin.write(JSON.stringify({ cancel: id }) + '\n'),
  };
}

test('--describe lists the contract without launching a browser', async () => {
  const child = spawn(process.execPath, [main, '--describe'], { env: environment.env });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await once(child, 'exit');
  const description = JSON.parse(out);
  assert.equal(description.available, true);
  assert.deepEqual(
    description.tools.map((tool) => tool.name),
    ['browser_tabs', 'browser_open', 'browser_close', 'browser_navigate', 'browser_read', 'browser_screenshot',
      'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll',
      'browser_wait', 'browser_evaluate'],
  );
});

test('--describe reports an unusable browser', async () => {
  const child = spawn(process.execPath, [main, '--describe'], {
    env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: '/nonexistent/chromium' },
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  await once(child, 'exit');
  const description = JSON.parse(out);
  assert.equal(description.available, false);
  assert.match(description.reason, /PUPPETEER_EXECUTABLE_PATH/);
});

test('protocol: errors, per-call deadline, cancellation and exit on input close', { skip }, async () => {
  const site = await startSite();
  const host = startHost();
  try {
    const bad = await host.request('browser_open', { url: 'file:///etc/hostname' }).reply;
    assert.deepEqual([bad.ok, /Only HTTP/.test(bad.error)], [false, true]);

    const opened = await host.request('browser_open', { url: site.url('/second') }).reply;
    assert.equal(opened.ok, true);
    assert.equal(opened.result.title, 'Second page');

    const started = Date.now();
    const slow = await host.request('browser_open', { url: site.url('/stall') }, 700).reply;
    assert.equal(slow.ok, false);
    assert.match(slow.error, /deadline expired/);
    assert.ok(Date.now() - started < 5000);

    const pending = host.request('browser_open', { url: site.url('/stall') }, 60000);
    setTimeout(() => host.cancel(pending.id), 300);
    const canceled = await pending.reply;
    assert.match(canceled.error, /canceled/);

    const tabs = await host.request('browser_tabs').reply;
    assert.deepEqual(tabs.result.tabs.map((tab) => tab.title), ['Second page']);
  } finally {
    host.child.stdin.end();
    const [code] = await once(host.child, 'exit');
    assert.equal(code, 0);
    await site.close();
  }
});

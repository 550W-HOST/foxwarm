'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const repository = path.resolve(__dirname, '..');
const output = path.join(repository, 'dotnet/Foxwarm/bin/Debug/net10.0');
const linux = { skip: process.platform !== 'linux' && 'Linux source-entry qualification' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(message);
}
function running(pid) {
  try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function fixture(t, built = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-entry-'));
  const app = path.join(root, 'app with spaces');
  const cwd = path.join(root, 'outside');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'scripts/main.js' }));
  for (const file of ['main.js', 'core-executable.js'])
    fs.copyFileSync(path.join(__dirname, file), path.join(app, 'scripts', file));
  if (built) {
    assert(fs.existsSync(path.join(output, 'Foxwarm.dll')), 'Run npm run build before source-entry tests.');
    const bin = path.join(app, 'dotnet/Foxwarm/bin/Debug');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(output, path.join(bin, 'net10.0'), 'dir');
  }
  const data = path.join(app, 'selected data');
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data_dir'), ' selected data \n');
  fs.writeFileSync(path.join(app, 'app.yaml'), 'vector: false\nbot:\n  enableWebUI: false\n  enableTrigger: false\n  enableTUI: true\n');
  fs.writeFileSync(path.join(app, 'wrong.yaml'), 'bot: {httpPort: -1}\n');
  const preload = path.join(root, 'no-typescript.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'); const load=Module._load; Module._load=function(id,...args){ if(typeof id==='string' && (id.includes('/lib/index') || id.includes(${JSON.stringify(path.join(repository, 'lib') + path.sep)}))) throw Error('TS Main loaded'); return load.call(this,id,...args); };`);
  const env = { ...process.env, FOXWARM_APP_ROOT: '', FOXWARM_DATA_DIR: '',
    FOXWARM_CONFIG_PATH: 'app.yaml', CONFIG_PATH: 'wrong.yaml',
    FOXWARM_EXPERIMENT_DATA_ROOT: '', FOXWARM_EXPERIMENT_TOOL_ROOT: '', FOXWARM_EXPERIMENT_SKILLS_ROOT: '',
    FOXWARM_MAIN_LIFETIME_PIPE: '', FOXWARM_HTTP_PORT: '', FOXWARM_BIND_ADDRESS: '127.0.0.1',
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
  // Empty optional host port variables are invalid overrides, not an unset selection.
  delete env.FOXWARM_HTTP_PORT;
  const children = [];
  async function launch(args = [app], overrides = {}, launchCwd = cwd) {
    const child = spawn(process.execPath, args, { cwd: launchCwd, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', value => { text += value; });
    child.stderr.on('data', value => { text += value; });
    const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    const instance = { child, exited, get text() { return text; } };
    children.push(instance);
    return instance;
  }
  async function ready(instance, message = 'Main started without HTTP.') {
    await until(() => {
      assert.equal(instance.child.exitCode, null, instance.text);
      return instance.text.includes(message);
    }, instance.text || 'Main did not start.');
    const pid = Number(execFileSync('pgrep', ['-P', String(instance.child.pid)], { encoding: 'utf8' }).trim());
    assert(Number.isInteger(pid) && pid > 1);
    assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'), /Foxwarm\.dll/);
    return pid;
  }
  t.after(async () => {
    for (const instance of children) {
      if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill('SIGTERM');
      await instance.exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, app, cwd, data, env, launch, ready };
}

test('package entry fails clearly without managed output and rejects explicit Main TUI', async t => {
  const f = fixture(t, false);
  const missing = await f.launch();
  assert.deepEqual(await missing.exited, { code: 1, signal: null });
  assert.match(missing.text, /build output is missing/);
  assert(!fs.existsSync(path.join(f.data, 'state/token')));
  if (fs.existsSync(path.join(output, 'Foxwarm.dll'))) {
    const built = fixture(t);
    const unavailable = await built.launch([built.app], { PATH: '' });
    assert.deepEqual(await unavailable.exited, { code: 1, signal: null });
    assert.match(unavailable.text, /Cannot launch Foxwarm Main.*ENOENT/);
    const tui = await built.launch([built.app, '--tui']);
    assert.deepEqual(await tui.exited, { code: 2, signal: null });
    assert.match(tui.text, /Main TUI is not implemented/);
    assert(!tui.text.includes('Main started'));
    assert(!fs.existsSync(path.join(built.data, 'state/token')));
  }
});

test('directory and resolved package execution keep installation identity, config and ordinary signal exit', linux, async t => {
  const f = fixture(t);
  // A real package resolver selects the JS execution boundary; it is not an import API.
  const resolved = require.resolve(f.app);
  assert.equal(resolved, path.join(f.app, 'scripts/main.js'));
  for (const entry of [f.app, resolved]) {
    const instance = await f.launch([entry]);
    const pid = await f.ready(instance);
    assert.match(instance.text, /Configured bot.enableTUI is ignored/);
    assert(fs.existsSync(path.join(f.data, 'agents/main/memory')));
    assert(!fs.existsSync(path.join(f.cwd, 'state')));
    assert(!fs.existsSync(path.join(f.app, 'state')));
    instance.child.kill('SIGTERM');
    assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
    await until(() => !running(pid), 'Managed Main survived foreground launcher shutdown.');
  }
});

test('explicit app/data/config environment wins without moving state to binary output', linux, async t => {
  const f = fixture(t);
  const other = path.join(f.root, 'explicit installation');
  const selected = path.join(other, 'explicit-data');
  fs.mkdirSync(selected, { recursive: true });
  fs.writeFileSync(path.join(other, 'chosen.yaml'), 'vector: false\nbot: {enableWebUI: false, enableTrigger: false}\n');
  const instance = await f.launch([f.app], { FOXWARM_APP_ROOT: other, FOXWARM_DATA_DIR: 'explicit-data', FOXWARM_CONFIG_PATH: 'chosen.yaml' });
  const pid = await f.ready(instance);
  assert(fs.existsSync(path.join(selected, 'agents/main/memory')));
  assert(!fs.existsSync(path.join(f.data, 'agents')));
  instance.child.kill('SIGINT');
  assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
  await until(() => !running(pid), 'Managed Main survived SIGINT.');
});

test('a hard foreground-parent termination requests Main drain rather than leaving Main running', linux, async t => {
  const f = fixture(t);
  const instance = await f.launch();
  const pid = await f.ready(instance);
  instance.child.kill('SIGKILL');
  assert.deepEqual(await instance.exited, { code: null, signal: 'SIGKILL' });
  await until(() => !running(pid), 'Managed Main survived its foreground parent.');
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`launcher ${signal} waits for a real accepted canonical owner before Main exits`, linux, async t => {
    const f = fixture(t);
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const request = new Promise(resolve => { reached = resolve; });
    const peer = http.createServer(async (req, res) => {
      for await (const _ of req) { /* consume the real request */ }
      reached(); await held;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'entry-drained' }] }] } }) + '\n\n');
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    t.after(() => { release(); peer.closeAllConnections(); peer.close(); });
    fs.writeFileSync(path.join(f.app, 'app.yaml'), `vector: false\nbot: {httpPort: ${port}}\n`);
    fs.writeFileSync(path.join(f.data, 'state/token'), 'synthetic-entry-token');
    fs.writeFileSync(path.join(f.data, 'state/models.yaml'), JSON.stringify({ default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }));
    const instance = await f.launch();
    const pid = await f.ready(instance, `Main HTTP listening: http://127.0.0.1:${port}`);
    async function post(route, body) {
      const result = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-entry-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await result.json();
      assert(result.ok, `${route}: ${result.status} ${JSON.stringify(value)}`);
      return value;
    }
    const { sessionId } = await post('/api/sessions', { agentId: 'main', sessionId: 'drain-entry' });
    await post('/api/sessions/' + encodeURIComponent(sessionId) + '/message', { text: 'qualification' });
    await request;
    const faults = path.join(f.data, 'state/experiment-faults');
    fs.mkdirSync(faults, { recursive: true });
    const hold = path.join(faults, 'id_' + Buffer.from(sessionId).toString('base64url') + '.canonical-hold-before-rename');
    fs.writeFileSync(hold, 'owned qualification');
    release();
    await until(() => fs.existsSync(hold + '.reached'), 'Canonical owner did not reach its publication barrier.');
    instance.child.kill(signal);
    await sleep(150);
    assert(running(pid), 'Main exited instead of draining its accepted canonical owner.');
    fs.rmSync(hold);
    assert.deepEqual(await instance.exited, signal === 'SIGKILL' ? { code: null, signal } : { code: 0, signal: null }, instance.text);
    await until(() => !running(pid), 'Managed Main survived a completed drain.');
    const saved = JSON.parse(fs.readFileSync(path.join(f.data, 'state/sessions', sessionId + '.json'), 'utf8'));
    assert.equal(saved.busy, false);
    assert(JSON.stringify(saved.history).includes('entry-drained'));
  });
}

test('relative explicit installation root is captured before a launcher changes cwd', linux, async t => {
  const f = fixture(t);
  const other = path.join(f.cwd, 'relative installation');
  fs.mkdirSync(path.join(other, 'state'), { recursive: true });
  fs.writeFileSync(path.join(other, 'chosen.yaml'), 'vector: false\nbot: {enableWebUI: false, enableTrigger: false}\n');
  const relative = path.relative(f.cwd, other);
  // The Windows client selects data before spawning from its installation cwd.
  const selector = execFileSync(process.execPath, ['-e', `const {resolveDataRoot}=require(${JSON.stringify(path.join(__dirname, 'windowsService'))}); const {coreEnvironment}=require(${JSON.stringify(path.join(__dirname, 'core-executable'))}); console.log(JSON.stringify({app:coreEnvironment().FOXWARM_APP_ROOT,data:resolveDataRoot()}));`], {
    cwd: f.cwd, env: { ...f.env, FOXWARM_APP_ROOT: relative }, encoding: 'utf8',
  });
  const selected = JSON.parse(selector);
  assert.deepEqual(selected, { app: other, data: other });
  const instance = await f.launch([f.app], { FOXWARM_APP_ROOT: selected.app, FOXWARM_DATA_DIR: selected.data, FOXWARM_CONFIG_PATH: 'chosen.yaml' }, f.app);
  const pid = await f.ready(instance);
  assert(fs.existsSync(path.join(other, 'agents/main/memory')));
  assert(!fs.existsSync(path.join(other, relative, 'agents')));
  instance.child.kill('SIGTERM');
  assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
  await until(() => !running(pid), 'Managed Main survived relative-root shutdown.');
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`foreground ${signal} stops Main while the production Matrix startup response remains held`, linux, async t => {
    const f = fixture(t);
    let reached;
    const request = new Promise(resolve => { reached = resolve; });
    let heldResponse;
    const peer = http.createServer((req, res) => {
      if (req.url === '/_matrix/client/versions') {
        heldResponse = res;
        reached();
      } else {
        res.writeHead(500); res.end('Unexpected request after startup stop');
      }
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    t.after(() => { peer.closeAllConnections(); peer.close(); });
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    fs.writeFileSync(path.join(f.app, 'app.yaml'), JSON.stringify({ vector: false, bot: { httpPort: port }, channels: { matrix: {
      homeserver: `http://127.0.0.1:${peer.address().port}`, accessToken: 'synthetic-matrix-token', botUserId: '@fixture:owned.invalid',
    } } }));
    fs.writeFileSync(path.join(f.data, 'state/token'), 'synthetic-startup-token');
    fs.writeFileSync(path.join(f.data, 'state/models.yaml'), JSON.stringify({ default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:9', models: ['wire'] } } }));
    const instance = await f.launch();
    const pid = await f.ready(instance, 'Main HTTP listening:');
    await request;
    const post = id => fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { authorization: 'Bearer synthetic-startup-token', 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'main', sessionId: id }), signal: AbortSignal.timeout(2000) });
    const before = await post('before-stop');
    assert.equal(before.status, 200, await before.text());
    instance.child.kill(signal);
    const exit = await Promise.race([instance.exited, sleep(5000).then(() => null)]);
    assert(exit, `Launcher did not exit while Matrix startup was held: ${instance.text}`);
    assert.deepEqual(exit, signal === 'SIGKILL' ? { code: null, signal } : { code: 0, signal: null }, instance.text);
    await until(() => !running(pid), 'Main survived parent stop during channel startup.');
    assert(!heldResponse.writableEnded, 'The fixture released startup before shutdown completed.');
    let after;
    try { after = await post('after-stop'); } catch { /* A closed listener is expected. */ }
    assert(!after || !after.ok, 'Stopped Main admitted a new Session.');
    // Releasing the original response after Main exit cannot publish a transport or restart it.
    heldResponse.end(JSON.stringify({ versions: ['v1.4'] }));
    assert(!running(pid));
  });
}

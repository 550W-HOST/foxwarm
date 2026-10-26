'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const repository = path.resolve(__dirname, '..');
const output = path.join(repository, 'runtime/current');
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
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error; }
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
    const bin = path.join(app, 'runtime');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(output, path.join(bin, 'current'), 'dir');
  }
  const data = path.join(app, 'selected data');
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data_dir'), ' selected data \n');
  fs.writeFileSync(path.join(data, 'state/config.yaml'), 'vector: false\nbot:\n  enableWebUI: false\n  enableTrigger: false\n  enableTUI: true\n');
  fs.writeFileSync(path.join(app, 'wrong.yaml'), 'bot: {httpPort: -1}\n');
  const preload = path.join(root, 'no-typescript.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'); const load=Module._load; Module._load=function(id,...args){ if(typeof id==='string' && (id.includes('/lib/index') || id.includes(${JSON.stringify(path.join(repository, 'lib') + path.sep)}))) throw Error('TS Main loaded'); return load.call(this,id,...args); };`);
  const env = { ...process.env, FOXWARM_SYNC_FILE_LOG: '0', FOXWARM_NO_CONSOLE_LOG: '', FOXWARM_LOG_STDERR: '',
    FOXWARM_APP_ROOT: '', FOXWARM_DATA_DIR: '',
    // Retired filename controls cannot redirect the selected data/state/config.yaml.
    FOXWARM_CONFIG_PATH: 'app.yaml', CONFIG_PATH: 'wrong.yaml',
    FOXWARM_EXPERIMENT_DATA_ROOT: '', FOXWARM_EXPERIMENT_TOOL_ROOT: '', FOXWARM_EXPERIMENT_SKILLS_ROOT: '',
    FOXWARM_MAIN_LIFETIME_PIPE: '',
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
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

test('retired installation environment cannot redirect package state', linux, async t => {
  const f = fixture(t);
  const other = path.join(f.cwd, 'retired installation');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'app.yaml'), 'bot: {httpPort: -1}\n');
  const instance = await f.launch([f.app], { FOXWARM_APP_ROOT: other,
    FOXWARM_EXPERIMENT_DATA_ROOT: other, FOXWARM_EXPERIMENT_TOOL_ROOT: other,
    FOXWARM_EXPERIMENT_SKILLS_ROOT: other });
  const pid = await f.ready(instance);
  assert(fs.existsSync(path.join(f.data, 'agents/main/memory')));
  assert(!fs.existsSync(path.join(other, 'state')));
  assert(!fs.existsSync(path.join(other, 'memory')));
  instance.child.kill('SIGINT');
  assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
  await until(() => !running(pid), 'Managed Main survived SIGINT.');
});

function longTemporaryDirectory(f) {
  const directory = path.join(f.root, 't'.repeat(Math.max(1, 106 - Buffer.byteLength(f.root) - 1)));
  fs.mkdirSync(directory);
  assert(Buffer.byteLength(directory) >= 106);
  return { TMPDIR: directory, TMP: directory, TEMP: directory };
}

test('package Main starts and stops with a valid long TMPDIR without replacing it', linux, async t => {
  const f = fixture(t);
  const temporary = longTemporaryDirectory(f);
  const instance = await f.launch([f.app], temporary);
  const pid = await f.ready(instance);
  const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  for (const [key, value] of Object.entries(temporary)) assert(environment.includes(`${key}=${value}`));
  assert.equal(fs.readlinkSync(`/proc/${pid}/cwd`), f.cwd);
  for (const fd of [0, 1, 2]) {
    assert.equal(fs.readlinkSync(`/proc/${pid}/fd/${fd}`), fs.readlinkSync(`/proc/${instance.child.pid}/fd/${fd}`));
  }
  instance.child.kill('SIGTERM');
  assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
  await until(() => !running(pid), 'Managed Main survived long-TMPDIR shutdown.');
});

test('a stop requested before managed entry starts remains queued on the lifetime pipe', linux, async t => {
  let release;
  t.after(() => release?.());
  const f = fixture(t);
  const bin = path.join(f.root, 'delayed-runtime');
  const reached = path.join(f.root, 'runtime-reached');
  const gate = path.join(f.root, 'release-runtime');
  fs.mkdirSync(bin);
  const dotnet = execFileSync('/bin/sh', ['-c', 'command -v dotnet'], { encoding: 'utf8' }).trim();
  // Hold only executable entry; the real launcher, inherited pipe and managed
  // lifetime owner remain unchanged. The timeout also bounds failure cleanup.
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/bash\nprintf reached > '${reached}'\nfor ((i=0; i<200; i++)); do [ -f '${gate}' ] && break; sleep 0.05; done\nexec '${dotnet}' "$@"\n`, { mode: 0o700 });
  release = () => fs.writeFileSync(gate, 'release');
  const instance = await f.launch([f.app], { ...longTemporaryDirectory(f), PATH: bin + path.delimiter + process.env.PATH });
  await until(() => fs.existsSync(reached), 'Launcher did not reach the owned runtime gate.');
  instance.child.kill('SIGTERM');
  // Let the launcher record the request while managed entry is still held.
  await sleep(100);
  assert.equal(instance.child.exitCode, null);
  release();
  assert.deepEqual(await instance.exited, { code: 0, signal: null }, instance.text);
  assert(!instance.text.includes('Main started'));
  assert(!fs.existsSync(path.join(f.data, 'agents')));
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
  test(`launcher ${signal} preserves a completed owner and its independent exec`, linux, async t => {
    let releaseExec;
    t.after(() => releaseExec?.());
    const f = fixture(t);
    const effect = path.join(f.root, 'independent-effect');
    const execGate = path.join(f.root, 'release-exec');
    const temporarySeen = path.join(f.root, 'exec-tmpdir');
    const temporaryFile = path.join(f.root, 'exec-tempfile');
    releaseExec = () => fs.writeFileSync(execGate, 'release');
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    let release, reached;
    const held = new Promise(resolve => { release = resolve; });
    const request = new Promise(resolve => { reached = resolve; });
    let launchedExec = false;
    const peer = http.createServer(async (req, res) => {
      for await (const _ of req) { /* consume the real request */ }
      if (signal === 'SIGKILL' && !launchedExec) {
        launchedExec = true;
        const command = `printf '%s' "$TMPDIR" > '${temporarySeen}'; mktemp > '${temporaryFile}'; printf started > '${effect}'; for ((i=0; i<200; i++)); do [ -f '${execGate}' ] && break; sleep 0.05; done; printf done >> '${effect}'`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'independent-exec', name: 'exec', arguments: JSON.stringify({ command, timeout: 1 }) }] } }) + '\n\n');
        return;
      }
      reached(); await held;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'entry-drained' }] }] } }) + '\n\n');
    });
    peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
    t.after(() => { release(); peer.closeAllConnections(); peer.close(); });
    fs.writeFileSync(path.join(f.data, 'state/config.yaml'), `vector: false\nbot: {httpPort: ${port}}\n`);
    fs.writeFileSync(path.join(f.data, 'state/token'), 'synthetic-entry-token');
    fs.writeFileSync(path.join(f.data, 'state/models.yaml'), JSON.stringify({ default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }));
    // Exercise long-directory IPC during real owner work and independent exec.
    const temporary = signal === 'SIGKILL' ? longTemporaryDirectory(f) : {};
    const instance = await f.launch([f.app], temporary);
    const pid = await f.ready(instance, `Main HTTP listening: http://0.0.0.0:${port}`);
    async function post(route, body) {
      const result = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-entry-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await result.json();
      assert(result.ok, `${route}: ${result.status} ${JSON.stringify(value)}`);
      return value;
    }
    const { sessionId } = await post('/api/sessions', { agentId: 'main', sessionId: 'drain-entry' });
    await post('/api/sessions/' + encodeURIComponent(sessionId) + '/message', { text: 'qualification' });
    await request;
    if (signal === 'SIGKILL') {
      assert.equal(fs.readFileSync(effect, 'utf8'), 'started');
      assert.equal(fs.readFileSync(temporarySeen, 'utf8'), temporary.TMPDIR);
      const created = fs.readFileSync(temporaryFile, 'utf8').trim();
      assert.equal(path.dirname(created), temporary.TMPDIR);
      assert(fs.existsSync(created));
    }
    release();
    await until(() => {
      const state = JSON.parse(fs.readFileSync(path.join(f.data, 'state/sessions', sessionId + '.json'), 'utf8'));
      return !state.busy && JSON.stringify(state.history).includes('entry-drained');
    }, 'Accepted owner did not finish before launcher termination.');
    instance.child.kill(signal);
    assert.deepEqual(await instance.exited, signal === 'SIGKILL' ? { code: null, signal } : { code: 0, signal: null }, instance.text);
    await until(() => !running(pid), 'Managed Main survived a completed drain.');
    const saved = JSON.parse(fs.readFileSync(path.join(f.data, 'state/sessions', sessionId + '.json'), 'utf8'));
    assert.equal(saved.busy, false);
    assert(JSON.stringify(saved.history).includes('entry-drained'));
    if (signal === 'SIGKILL') {
      assert.equal(fs.readFileSync(effect, 'utf8'), 'started', 'Independent exec ended before Main stopped.');
      releaseExec();
      await until(() => fs.readFileSync(effect, 'utf8') === 'starteddone', 'Main exit killed its independent exec helper.');
    }
  });
}

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
    fs.writeFileSync(path.join(f.data, 'state/config.yaml'), JSON.stringify({ vector: false, bot: { httpPort: port }, channels: { matrix: {
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

function tmuxFixture(t) {
  const cleanup = [];
  const f = fixture({ after: fn => cleanup.push(fn) });
  const bin = path.join(f.root, 'bin');
  const socket = path.join(f.root, 'tmux.socket');
  fs.mkdirSync(bin);
  for (const file of ['start.sh', 'restart.sh', 'build-source.js'])
    fs.copyFileSync(path.join(__dirname, file), path.join(f.app, 'scripts', file));
  const tmuxBin = execFileSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  // Only build acquisition is stubbed; the launcher and managed Main are real.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p build\nln -s "$TEST_CORE_OUTPUT" build/core\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nexec "$TEST_TMUX_BIN" -S "$TEST_TMUX_SOCKET" -f /dev/null "$@"\n`, { mode: 0o755 });
  const env = { ...f.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TEST_TMUX_BIN: tmuxBin, TEST_TMUX_SOCKET: socket, TEST_CORE_OUTPUT: fs.realpathSync(output), TMUX: '',
    FOXWARM_NODE_BIN: process.execPath, FOXWARM_TMUX_SESSION: 'root-selection',
    FOXWARM_DATA_DIR: 'selected data',
    FOXWARM_SYNC_FILE_LOG: '0' };
  function tmux(...args) {
    return execFileSync(tmuxBin, ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' }).trim();
  }
  t.after(async () => {
    spawnSync(tmuxBin, ['-S', socket, 'kill-server']);
    for (const release of cleanup) await release();
  });
  // A stale server root must not decide what this invocation selects.
  tmux('new-session', '-d', '-s', 'fixture');
  tmux('set-option', '-g', 'default-shell', '/bin/bash');
  tmux('set-option', '-g', 'automatic-rename', 'off');
  tmux('set-environment', '-g', 'FOXWARM_APP_ROOT', path.join(f.root, 'stale installation'));
  function install(app) {
    fs.mkdirSync(path.join(app, 'selected data/state'), { recursive: true });
    fs.writeFileSync(path.join(app, 'selected data/state/config.yaml'), 'vector: false\nbot: {enableWebUI: false, enableTrigger: false}\npaths: {agentsDir: "owned agents"}\n');
    fs.writeFileSync(path.join(app, 'wrong.yaml'), 'bot: {httpPort: -1}\n');
  }
  function pane() {
    return tmux('list-panes', '-t', '=root-selection:=foxwarm', '-F', '#{pane_id}');
  }
  function text() { return tmux('capture-pane', '-p', '-S', '-1000', '-t', pane()); }
  async function ready(count = 1) {
    await until(() => (text().match(/Main started without HTTP\./g) || []).length === count, 'Managed Main did not start in the private tmux pane.');
  }
  function run(script, root) {
    const launchEnv = { ...env };
    if (root === undefined) delete launchEnv.FOXWARM_APP_ROOT;
    else launchEnv.FOXWARM_APP_ROOT = root;
    const result = spawnSync('bash', [path.join(f.app, 'scripts', script)], {
      cwd: f.cwd, env: launchEnv, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  async function stop() {
    const before = (text().match(/Main stopped\./g) || []).length;
    tmux('send-keys', '-t', pane(), 'C-c');
    await until(() => (text().match(/Main stopped\./g) || []).length === before + 1, 'Managed Main did not stop.');
  }
  return { ...f, env, tmux, install, run, ready, stop, pane, text };
}

const tmuxMain = { skip: process.platform !== 'linux' || spawnSync('tmux', ['-V']).status !== 0
  ? 'Requires Linux, Bash and tmux' : false };
for (const script of ['start.sh', 'restart.sh']) {
  for (const mode of ['relative', 'absolute', 'omitted', 'empty']) {
    test(`Bash ${script} ignores a ${mode} retired installation setting`, tmuxMain, async t => {
      const f = tmuxFixture(t);
      const relative = 'selected installation';
      const explicit = path.join(f.cwd, relative);
      const wrong = path.join(f.app, relative);
      const expected = f.app;
      // Valid competing roots ensure ignored settings cannot quietly initialize another tree.
      for (const app of [explicit, wrong, f.app]) f.install(app);
      const input = { relative, absolute: explicit, omitted: undefined, empty: '' }[mode];
      f.run(script, input);
      await f.ready();
      assert(fs.existsSync(path.join(expected, 'owned agents/main/memory')), `Missing selected installation ${expected}; checkout sibling initialized: ${fs.existsSync(path.join(wrong, 'owned agents/main/memory'))}`);
      assert(fs.existsSync(path.join(expected, 'selected data/state/logs')), 'Diagnostic logs did not use installation-relative data.');
      for (const other of [explicit, wrong, f.app].filter(app => app !== expected))
        assert(!fs.existsSync(path.join(other, 'owned agents')), `Initialized unselected installation ${other}`);
      assert(!fs.existsSync(path.join(f.cwd, 'selected data')), 'Relative data escaped the selected installation.');
      await f.stop();
    });
  }
}

test('Bash restart stops the running Main and ignores retired installation overrides', tmuxMain, async t => {
  const f = tmuxFixture(t);
  const relative = 'next installation';
  const selected = path.join(f.cwd, relative);
  const wrong = path.join(f.app, relative);
  for (const app of [f.app, selected, wrong]) f.install(app);
  f.run('start.sh');
  await f.ready();
  const shell = f.tmux('display-message', '-p', '-t', f.pane(), '#{pane_pid}');
  const launcher = execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim();
  const main = Number(execFileSync('pgrep', ['-P', launcher], { encoding: 'utf8' }).trim());
  f.run('restart.sh', relative);
  await f.ready(2);
  assert(!running(main), 'Previous managed Main survived restart.');
  const log = f.text();
  assert(log.indexOf('Main stopped.') < log.lastIndexOf('Main started without HTTP.'), log);
  assert(fs.existsSync(path.join(f.app, 'owned agents/main/memory')));
  assert(!fs.existsSync(path.join(selected, 'owned agents')));
  assert(!fs.existsSync(path.join(wrong, 'owned agents')));
  await f.stop();
});

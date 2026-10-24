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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}
function running(pid) {
  try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// This lane deliberately performs complete asset/.NET builds three times. It
// reuses installed locked dependencies; npm ci alone is a fixture boundary.
// Run explicitly with FOXWARM_TEST_SOURCE_UPDATE=1, not in every unit batch.
test('real source builds, failed update, restart and delayed native completion', {
  skip: process.env.FOXWARM_TEST_SOURCE_UPDATE !== '1' || process.platform !== 'linux',
  timeout: 600000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-update-'));
  const app = path.join(root, 'source with spaces');
  const data = path.join(root, 'retained data');
  const bin = path.join(root, 'bin');
  const socket = path.join(root, 'tmux.socket');
  const gate = path.join(root, 'finish-exec');
  const effect = path.join(root, 'exec-effect');
  fs.mkdirSync(app);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  const excluded = new Set(['node_modules', 'bin', 'obj', 'dist', '.temp', '.cache']);
  for (const name of ['dotnet', 'src', 'scripts', 'skills', 'templates', 'packages',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.artifacts.json', 'LICENSE']) {
    fs.cpSync(path.join(repository, name), path.join(app, name), {
      recursive: true, filter: source => !path.relative(repository, source).split(path.sep).some(part => excluded.has(part)),
    });
  }
  for (const name of ['node_modules', 'packages/webui/node_modules'])
    fs.cpSync(path.join(repository, name), path.join(app, name), { recursive: true });
  const montyPackage = path.join(app, 'node_modules/@pydantic/monty-linux-x64-gnu');
  assert.equal(JSON.parse(fs.readFileSync(path.join(montyPackage, 'package.json'))).version, '0.0.19');
  const montyCache = path.join(app, 'dotnet/Foxwarm/obj/monty-0.0.19/linux-x64/bin');
  fs.mkdirSync(montyCache, { recursive: true });
  fs.copyFileSync(path.join(montyPackage, 'monty'), path.join(montyCache, 'monty'));
  const realNpm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
  const realTmux = execFileSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = ci ] || { [ "$1" = --prefix ] && [ "$3" = ci ]; }; then echo "Fixture: reuse installed locked dependencies"; exit 0; fi\nexec "$TEST_REAL_NPM" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec "$TEST_REAL_TMUX" -S "$TEST_TMUX_SOCKET" -f /dev/null "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REAL_NPM: realNpm,
    TEST_REAL_TMUX: realTmux, TEST_TMUX_SOCKET: socket, TMUX: '',
    FOXWARM_TMUX_SESSION: 'owned-update', FOXWARM_NODE_BIN: process.execPath,
    FOXWARM_DATA_DIR: '', FOXWARM_SYNC_FILE_LOG: '0', FOXWARM_NO_CONSOLE_LOG: '' };
  const tmux = (...args) => execFileSync(realTmux, ['-S', socket, '-f', '/dev/null', ...args], { env, encoding: 'utf8' }).trim();
  let mainPid;
  let peer;
  let record;
  let publishedLauncher;
  t.after(async () => {
    fs.writeFileSync(gate, 'finish');
    if (record) await until(() => !running(record.pid), 'Fixture exec did not finish.');
    if (publishedLauncher && publishedLauncher.exitCode === null && publishedLauncher.signalCode === null) {
      publishedLauncher.kill('SIGTERM');
      await once(publishedLauncher, 'exit');
    }
    spawnSync(realTmux, ['-S', socket, 'kill-server']);
    if (mainPid) await until(() => !running(mainPid), 'Fixture Main did not stop.');
    peer?.closeAllConnections();
    peer?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function run(label, command, args) {
    const log = path.join(root, `${label}.log`);
    const fd = fs.openSync(log, 'w');
    const child = spawn(command, args, { cwd: app, env, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const [code] = await once(child, 'exit');
    const text = fs.readFileSync(log, 'utf8');
    t.diagnostic(`${label}: exit ${code}`);
    return { code, text };
  }
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let called = false;
  peer = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume the real model request */ }
    const output = called
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'update-fixture-done' }] }]
      : [{ type: 'function_call', call_id: 'retained-helper', name: 'exec', arguments: JSON.stringify({
        command: `printf started > '${effect}'; for ((i=0; i<6000; i++)); do [ -f '${gate}' ] && break; sleep 0.05; done; printf done >> '${effect}'; exit 7`, timeout: 1,
      }) }];
    called = true;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n');
  });
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
  const config = `vector: false\nbot: {httpPort: ${port}}\n`;
  fs.writeFileSync(path.join(app, 'data_dir'), '../retained data\n');
  fs.writeFileSync(path.join(data, 'state/config.yaml'), config);
  fs.writeFileSync(path.join(data, 'state/token'), 'synthetic-source-update-token');
  fs.writeFileSync(path.join(data, 'state/models.yaml'), JSON.stringify({ default: 'owned', providers: {
    owned: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] },
  } }));
  async function request(route, body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer synthetic-source-update-token', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000),
    });
    const value = await response.json();
    assert(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  async function ready() {
    await until(async () => {
      try { await request('/api/setup/status'); return true; } catch { return false; }
    }, 'Replacement Main did not become ready.');
    const shell = tmux('display-message', '-p', '-t', '=owned-update:=foxwarm', '#{pane_pid}');
    const launcher = execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim();
    mainPid = Number(execFileSync('pgrep', ['-P', launcher], { encoding: 'utf8' }).trim());
    assert(mainPid > 1);
    return mainPid;
  }
  const current = path.join(app, 'runtime/current');
  assert(!fs.existsSync(current));
  const first = await run('first-start', 'bash', ['scripts/start.sh']);
  assert.equal(first.code, 0, first.text);
  const oldPid = await ready();
  const oldOutput = fs.realpathSync(current);
  const oldAssembly = path.join(oldOutput, 'Foxwarm.dll');
  const oldMtime = fs.statSync(oldAssembly).mtimeMs;
  assert(fs.readFileSync(`/proc/${oldPid}/cmdline`, 'utf8').includes(oldAssembly));
  assert(!fs.existsSync(path.join(app, 'build/core')));
  assert(!fs.existsSync(path.join(app, 'state')));
  const { sessionId } = await request('/api/sessions', { agentId: 'main', sessionId: 'retained-update' });
  await request('/api/sessions/' + encodeURIComponent(sessionId) + '/message', { text: 'start independent exec' });
  await until(() => {
    try {
      record = Object.values(JSON.parse(fs.readFileSync(path.join(data, 'state/running-exec.json'))).execs)[0];
      return record && fs.existsSync(effect);
    } catch { return false; }
  }, 'Independent exec was not recorded.');
  const scripts = fs.readdirSync(path.dirname(record.logPath)).filter(file => file.endsWith('.command.sh'));
  assert.equal(scripts.length, 1);
  assert(fs.readFileSync(path.join(path.dirname(record.logPath), scripts[0]), 'utf8').includes(oldAssembly));
  const invalidSource = path.join(app, 'dotnet/Foxwarm/UpdateFailure.cs');
  fs.writeFileSync(invalidSource, '#error Deliberate source-update fixture build failure\n');
  const failed = await run('failed-restart', 'bash', ['scripts/restart.sh']);
  assert.notEqual(failed.code, 0);
  assert.match(failed.text, /Deliberate source-update fixture build failure/);
  assert.equal(fs.realpathSync(current), oldOutput);
  assert.equal(fs.statSync(oldAssembly).mtimeMs, oldMtime);
  assert(!fs.existsSync(path.join(app, 'build/core')));
  assert(running(oldPid));
  await request('/api/setup/status');
  assert.equal(fs.readFileSync(effect, 'utf8'), 'started');
  fs.rmSync(invalidSource);
  const manifest = JSON.parse(fs.readFileSync(path.join(app, 'package.json')));
  const oldVersion = manifest.version;
  manifest.version = '9.8.7';
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(manifest, null, 2));
  const updated = await run('updated-restart', 'bash', ['scripts/restart.sh']);
  assert.equal(updated.code, 0, updated.text);
  const newPid = await ready();
  const newOutput = fs.realpathSync(current);
  assert.notEqual(newPid, oldPid);
  assert(!running(oldPid));
  assert.notEqual(newOutput, oldOutput);
  assert(fs.readFileSync(`/proc/${newPid}/cmdline`, 'utf8').includes(path.join(newOutput, 'Foxwarm.dll')));
  assert.equal(fs.statSync(oldAssembly).mtimeMs, oldMtime);
  const version = assembly => execFileSync('dotnet', [assembly, '--version'], { cwd: root, env, encoding: 'utf8' }).trim();
  assert.equal(version(oldAssembly), oldVersion);
  assert.equal(version(path.join(newOutput, 'Foxwarm.dll')), '9.8.7');
  assert.equal(fs.readFileSync(path.join(data, 'state/config.yaml'), 'utf8'), config);
  assert(fs.existsSync(path.join(data, 'state/sessions', sessionId + '.json')));
  assert.equal(fs.readFileSync(effect, 'utf8'), 'started');
  fs.writeFileSync(gate, 'finish');
  await until(() => fs.existsSync(record.statusPath), 'Old DLL helper did not publish completion after replacement.');
  assert.equal(JSON.parse(fs.readFileSync(record.statusPath)).exitCode, 7);
  assert.equal(fs.readFileSync(effect, 'utf8'), 'starteddone');
  const cli = await run('source-cli', process.execPath, ['scripts/foxwarm.js', 'model', '--list']);
  assert.equal(cli.code, 0, cli.text);
  assert.match(cli.text, /wire/);
  const selector = execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./scripts/core-executable").coreExecutable()))'], { cwd: app, env, encoding: 'utf8' });
  assert.equal(JSON.parse(selector).args[0], path.join(newOutput, 'Foxwarm.dll'));
  const published = path.join(root, 'published');
  const publish = await run('publish', 'dotnet', ['publish', 'dotnet/Foxwarm/Foxwarm.csproj', '-c', 'Release', '--self-contained', 'false', '-o', published]);
  assert.equal(publish.code, 0, publish.text);
  const selected = JSON.parse(execFileSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(published, 'scripts/core-executable.js'))}).coreExecutable()))`], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(selected.command, path.join(published, 'Foxwarm'));
  assert.equal(execFileSync(selected.command, [...selected.args, '--version'], { cwd: root, env, encoding: 'utf8' }).trim(), '9.8.7');
  const publishedData = path.join(root, 'published-data');
  fs.mkdirSync(path.join(publishedData, 'state'), { recursive: true });
  fs.writeFileSync(path.join(publishedData, 'state/config.yaml'), 'vector: false\nbot: {enableWebUI: false, enableTrigger: false}\n');
  async function publishedMain(expectedExecutable) {
    publishedLauncher = spawn(process.execPath, [published], {
      cwd: root, env: { ...env, FOXWARM_DATA_DIR: publishedData }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    publishedLauncher.stdout.on('data', value => { text += value; });
    publishedLauncher.stderr.on('data', value => { text += value; });
    const exited = once(publishedLauncher, 'exit');
    await until(() => {
      assert.equal(publishedLauncher.exitCode, null, text);
      return text.includes('Main started without HTTP.');
    }, 'Published package Main did not start.');
    const pid = Number(execFileSync('pgrep', ['-P', String(publishedLauncher.pid)], { encoding: 'utf8' }).trim());
    assert(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(expectedExecutable));
    publishedLauncher.kill('SIGTERM');
    assert.deepEqual(await exited, [0, null], text);
    await until(() => !running(pid), 'Published Main survived package parent stop.');
  }
  await publishedMain(path.join(published, 'Foxwarm'));
  fs.rmSync(path.join(published, 'Foxwarm'));
  const dllSelected = JSON.parse(execFileSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(published, 'scripts/core-executable.js'))}).coreExecutable()))`], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(dllSelected.command, 'dotnet');
  assert.equal(dllSelected.args[0], path.join(published, 'Foxwarm.dll'));
  await publishedMain(path.join(published, 'Foxwarm.dll'));
  t.diagnostic(`Real Main ${oldPid} -> ${newPid}; assembly ${oldVersion} -> 9.8.7; retained helper exit 7; source CLI and published apphost/DLL Main startup/drain passed.`);
});

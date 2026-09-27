#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const { loadConfig } = require('./multicaBridge.js');
const { parseSetupArgs, resolveSetup, runSetup } = require('./multicaBridgeSetup.js');

function captureStream() {
  let value = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } });
  return { stream, value: () => value };
}

async function createFakeFoxwarm(options = {}) {
  const state = { agents: new Set(options.agents || []), creates: 0 };
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer fox-token') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'denied fox-token reflected-secret' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/agents') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ agents: [...state.agents].map(id => ({ id })) }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/agents') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      state.creates += 1;
      state.agents.add(parsed.agentId);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, agentId: parsed.agentId }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function createFakeMultica(root) {
  const executable = path.join(root, 'multica-fake');
  const statePath = path.join(root, 'multica-state.json');
  await fsp.writeFile(statePath, JSON.stringify({ profiles: [], calls: [] }));
  const source = `#!${process.execPath}
const fs = require('node:fs');
const statePath = process.env.FAKE_MULTICA_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const rawArgs = process.argv.slice(2);
const profile = rawArgs[0] === '--profile' ? rawArgs[1] : '';
const args = profile ? rawArgs.slice(2) : rawArgs;
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const command = args.slice(0, 3).join(' ');
state.calls.push({ args: rawArgs, command, profile, sawFoxwarmToken: Boolean(process.env.FOXWARM_MULTICA_TOKEN) });
if (command === 'runtime profile list') {
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (process.env.FAKE_MULTICA_FAIL_LIST === '1') { console.error('server body reflected-secret fox-token'); process.exit(1); }
  console.log(JSON.stringify(state.profiles));
} else if (command === 'runtime profile create') {
  const profile = { id: 'profile-1', protocol_family: value('--protocol-family'), command_name: value('--command-name'), display_name: value('--display-name'), enabled: true };
  state.profiles.push(profile); fs.writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify(profile));
} else if (command === 'runtime profile update') {
  const profile = state.profiles.find(item => item.id === args[3]);
  if (!profile) process.exit(1);
  if (value('--command-name')) profile.command_name = value('--command-name');
  if (value('--display-name')) profile.display_name = value('--display-name');
  if (args.includes('--enabled=true')) profile.enabled = true;
  fs.writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify(profile));
} else if (command === 'runtime profile set-path') {
  state.lastPath = { id: args[3], path: value('--path') }; fs.writeFileSync(statePath, JSON.stringify(state)); console.log('pinned');
} else { fs.writeFileSync(statePath, JSON.stringify(state)); process.exit(2); }
`;
  await fsp.writeFile(executable, source, { mode: 0o755 });
  await fsp.chmod(executable, 0o755);
  return {
    executable,
    statePath,
    read: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
  };
}

function setupEnv(fakeMultica, extra = {}) {
  return {
    ...process.env,
    FAKE_MULTICA_STATE: fakeMultica.statePath,
    ...extra,
  };
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

test('setup parser refuses token secrets in argv', () => {
  assert.throws(() => parseSetupArgs(['--token', 'secret']), /not accepted in argv/);
  assert.throws(() => parseSetupArgs(['--instance', '../bad']), /--instance/);
  assert.equal(parseSetupArgs(['--multica-profile=']).multicaProfile, '');
});

test('setup defaults to the canonical Foxwarm WebUI port', async t => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'foxwarm-multica-default-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const setup = await resolveSetup(parseSetupArgs([]), { HOME: home, FOXWARM_MULTICA_TOKEN: 'fox-token' });
  assert.equal(setup.baseUrl, 'http://127.0.0.1:3001');
  assert.equal(setup.multicaProfile, '');
});

test('setup creates private target, agent, profile/path pin and reruns idempotently', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foxwarm-multica-setup-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const foxwarm = await createFakeFoxwarm();
  t.after(foxwarm.close);
  const multica = await createFakeMultica(root);
  const installRoot = path.join(root, 'install');
  const tokenFile = path.join(root, 'token');
  await fsp.writeFile(tokenFile, 'fox-token\n', { mode: 0o600 });
  const stdout = captureStream();
  const stderr = captureStream();
  const args = [
    '--url', foxwarm.url, '--agent', 'multica_bridge', '--token-file', tokenFile,
    '--instance', 'prod', '--display-name', 'Foxwarm Production', '--multica', multica.executable,
    '--multica-profile', 'team-a', '--install-root', installRoot, '--create-agent',
  ];
  const options = { env: setupEnv(multica), stdout: stdout.stream, stderr: stderr.stream };
  assert.equal(await runSetup(args, options), 0, stderr.value());
  assert.equal(foxwarm.state.creates, 1);
  assert.equal(foxwarm.state.agents.has('multica_bridge'), true);

  const instanceDir = path.join(installRoot, 'prod');
  const configPath = path.join(instanceDir, 'config.json');
  const launcherPath = path.join(instanceDir, 'foxwarm-multica-prod');
  assert.equal(mode(instanceDir), 0o700);
  assert.equal(mode(configPath), 0o600);
  assert.equal(mode(launcherPath), 0o700);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.token, 'fox-token');
  assert.equal(config.runtimeProfileId, 'profile-1');
  assert.equal(config.multicaProfile, 'team-a');
  const loaded = loadConfig({ FOXWARM_MULTICA_CONFIG: configPath, FOXWARM_MULTICA_TOKEN: 'wrong-global-token' });
  assert.equal(loaded.agent, 'multica_bridge');
  assert.equal(loaded.token, 'fox-token');
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  assert.doesNotMatch(launcher, /fox-token/);
  assert.match(launcher, /FOXWARM_MULTICA_CONFIG/);
  assert.match(launcher, /unset FOXWARM_MULTICA_BASE_URL FOXWARM_MULTICA_TOKEN/);

  let multicaState = multica.read();
  assert.equal(multicaState.profiles.length, 1);
  assert.deepEqual(multicaState.profiles[0], {
    id: 'profile-1', protocol_family: 'qwen', command_name: 'foxwarm-multica-prod',
    display_name: 'Foxwarm Production', enabled: true,
  });
  assert.deepEqual(multicaState.lastPath, { id: 'profile-1', path: launcherPath });
  assert.ok(multicaState.calls.every(call => !call.sawFoxwarmToken));
  assert.ok(multicaState.calls.every(call => !call.args.includes('fox-token')));
  assert.ok(multicaState.calls.every(call => call.profile === 'team-a'));
  assert.doesNotMatch(`${stdout.value()}${stderr.value()}`, /fox-token/);
  assert.match(stdout.value(), /'--profile' 'team-a' 'daemon' 'restart'/);
  assert.match(stdout.value(), /'--profile' 'team-a' 'daemon' 'start'/);
  assert.match(stdout.value(), /For Docker, mount the launcher\/config\/bridge/);

  const rerunOut = captureStream();
  assert.equal(await runSetup(args, { ...options, stdout: rerunOut.stream }), 0);
  multicaState = multica.read();
  assert.equal(multicaState.profiles.length, 1);
  assert.equal(multicaState.calls.filter(call => call.command === 'runtime profile create').length, 1);
  assert.equal(multicaState.calls.filter(call => call.command === 'runtime profile set-path').length, 2);
  assert.match(rerunOut.value(), /reused/);

  const renamedArgs = [...args];
  renamedArgs[renamedArgs.indexOf('--display-name') + 1] = 'Foxwarm Production Renamed';
  assert.equal(await runSetup(renamedArgs, { ...options, stdout: captureStream().stream }), 0);
  multicaState = multica.read();
  assert.equal(multicaState.profiles.length, 1);
  assert.equal(multicaState.profiles[0].display_name, 'Foxwarm Production Renamed');
  assert.equal(multicaState.calls.filter(call => call.command === 'runtime profile update').length, 1);
  assert.ok(multicaState.calls.every(call => call.profile === 'team-a'));
});

test('setup reports Foxwarm auth and missing-agent errors without local mutation or secret reflection', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foxwarm-multica-errors-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const foxwarm = await createFakeFoxwarm();
  t.after(foxwarm.close);
  const multica = await createFakeMultica(root);
  const installRoot = path.join(root, 'install');

  const authOut = captureStream();
  const authErr = captureStream();
  assert.equal(await runSetup([
    '--url', foxwarm.url, '--agent', 'missing', '--instance', 'auth', '--multica', multica.executable, '--install-root', installRoot,
  ], { env: setupEnv(multica, { FOXWARM_MULTICA_TOKEN: 'wrong-token' }), stdout: authOut.stream, stderr: authErr.stream }), 1);
  assert.doesNotMatch(`${authOut.value()}${authErr.value()}`, /wrong-token|fox-token|reflected-secret/);
  assert.equal(fs.existsSync(installRoot), false);

  const agentErr = captureStream();
  assert.equal(await runSetup([
    '--url', foxwarm.url, '--agent', 'missing', '--instance', 'agent', '--multica', multica.executable, '--install-root', installRoot,
  ], { env: setupEnv(multica, { FOXWARM_MULTICA_TOKEN: 'fox-token' }), stdout: captureStream().stream, stderr: agentErr.stream }), 1);
  assert.match(agentErr.value(), /--create-agent/);
  assert.equal(foxwarm.state.creates, 0);
  assert.equal(fs.existsSync(installRoot), false);
});

test('setup fails actionably when Multica auth/workspace is unavailable before creating an agent', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foxwarm-multica-login-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const foxwarm = await createFakeFoxwarm();
  t.after(foxwarm.close);
  const multica = await createFakeMultica(root);
  const stderr = captureStream();
  const code = await runSetup([
    '--url', foxwarm.url, '--agent', 'new-agent', '--instance', 'login', '--multica', multica.executable,
    '--install-root', path.join(root, 'install'), '--create-agent',
  ], {
    env: setupEnv(multica, { FOXWARM_MULTICA_TOKEN: 'fox-token', FAKE_MULTICA_FAIL_LIST: '1' }),
    stdout: captureStream().stream, stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.value(), /'login'.*'workspace' 'switch'/);
  assert.doesNotMatch(stderr.value(), /fox-token|reflected-secret/);
  assert.equal(foxwarm.state.creates, 0);
});

test('dry-run validates target and profile plan without any mutation', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foxwarm-multica-dry-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const foxwarm = await createFakeFoxwarm();
  t.after(foxwarm.close);
  const multica = await createFakeMultica(root);
  const installRoot = path.join(root, 'install');
  const stdout = captureStream();
  const code = await runSetup([
    '--url', foxwarm.url, '--agent', 'would-create', '--instance', 'dry', '--multica', multica.executable,
    '--install-root', installRoot, '--create-agent', '--dry-run',
  ], { env: setupEnv(multica, { FOXWARM_MULTICA_TOKEN: 'fox-token' }), stdout: stdout.stream, stderr: captureStream().stream });
  assert.equal(code, 0);
  assert.match(stdout.value(), /Dry run passed/);
  assert.match(stdout.value(), /would create/);
  assert.equal(foxwarm.state.creates, 0);
  assert.equal(fs.existsSync(installRoot), false);
  const state = multica.read();
  assert.equal(state.profiles.length, 0);
  assert.deepEqual(state.calls.map(call => call.command), ['runtime profile list']);
});

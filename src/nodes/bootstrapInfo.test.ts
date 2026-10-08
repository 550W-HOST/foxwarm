import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeBootstrapInfo, buildNodeBootstrapCommands, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER } from './bootstrapInfo';
import * as tools from '../tools';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('bootstrap retains external metadata and gives independent literal-address commands', () => {
  const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: '' });
  assert.equal(result.pairingToken, 'TOKEN123');
  assert.equal(result.baseUrl.placeholder, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER);
  assert.equal(result.baseUrl.requestDerivedDefaultInDownloadedScripts, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER);
  assert.equal(result.baseUrl.canSystemKnowUniqueExternalBaseUrl, false);
  assert.equal(result.endpoints.runShUrl, 'http://YOUR_MASTER:3001/node/run.sh');
  for (const command of Object.values(result.examples)) assert.doesNotMatch(command, /BASE_URL/);
  assert.match(result.examples.bareMetal, /--dir='\/opt\/foxwarm-node'/);
  assert.match(result.examples.bareMetal, /--host='http:\/\/YOUR_MASTER:3001'/);
  assert.match(result.examples.bareMetal, /--pairing='TOKEN123'/);
  assert.match(result.examples.bareMetalBackground, /-d/);
  assert.match(result.examples.bareMetalInstall, /--install/);
});

test('PowerShell commands inline literal addresses with explicit origin or deployment host', () => {
  for (const url of ['http://YOUR_MASTER:3001', 'https://example.invalid', "https://example.invalid/fox'base/$literal"]) {
    const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: url });
    assert.equal(result.endpoints.sourceUrl, `${url}/node/source.tar.gz`);
    const [fetch, run] = result.examples.windows.split('\n');
    const target = /^Invoke-WebRequest '((?:[^']|'')*)' -OutFile \.\\run\.ps1$/.exec(fetch)?.[1];
    assert.equal(target?.replace(/''/g, "'"), `${url}/node/run.ps1`);
    const host = /-HostUrl '((?:[^']|'')*)' -Pairing/.exec(run)?.[1];
    assert.equal(host?.replace(/''/g, "'"), url);
    assert.match(run, /-Pairing 'TOKEN123' -NodeId 'my-node'$/);
    for (const command of Object.values(result.examples)) assert.doesNotMatch(command, /BASE_URL/);
  }
});

test('generated manual Compose commands preserve a path with shell/Compose metacharacters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-compose-example-'));
  try {
    const bin = path.join(root, 'bin');
    await fs.ensureDir(bin);
    for (const command of ['curl', 'docker']) {
      await fs.writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const url = "https://example.invalid/fox'base/$literal";
    const example = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: url });
    await execFileAsync('/bin/bash', ['-c', example.examples.manualCompose], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 3_000,
    });
    const envFile = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(envFile, /NODE_HOST='https:\/\/example.invalid\/fox\\'base\/\$literal'/);
    assert.match(envFile, /NODE_SOURCE_URL='https:\/\/example.invalid\/fox\\'base\/\$literal\/node\/source.tar.gz'/);
    assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o077, 0);
    await fs.copy(path.resolve(__dirname, '../../templates/node/docker-compose.yaml'), path.join(root, 'docker-compose.yaml'));
    const { stdout } = await execFileAsync('docker', ['compose', 'config', '--format', 'json'], { cwd: root, timeout: 5000 });
    const service = JSON.parse(stdout).services['foxwarm-node'];
    // Compose represents a literal dollar using $$ in serialized service values.
    assert.equal(service.environment.NODE_URL.replace(/\$\$/g, '$'), url);
    assert.equal(service.build.args.NODE_SOURCE_URL.replace(/\$\$/g, '$'), `${url}/node/source.tar.gz`);
  } finally {
    await fs.remove(root);
  }
});

test('each shell launcher command executes independently with literal URL, directory and credential arguments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-inline-node-'));
  try {
    const bin = path.join(root, 'bin'); await fs.ensureDir(bin);
    await fs.writeFile(path.join(bin, 'curl'), `#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; http*) printf '%s\\0' "$1" >> "$CURL_LOG"; shift ;; *) shift ;; esac
done
if [ -n "$out" ]; then
  printf '#!/bin/sh\\nprintf \"%%s\\\\0\" \"$@\" >> \"$LAUNCH_LOG\"\\n' > "$out"
else
  printf '#!/bin/sh\\nprintf \"%%s\\\\0\" \"$@\" >> \"$LAUNCH_LOG\"\\n'
fi
`, { mode: 0o755 });
    const url = "https://example.invalid/deploy'path/$literal";
    const directory = "/opt/node's directory/$literal";
    const token = "fixture'token/$literal";
    const commands = buildNodeBootstrapCommands({ baseUrl: url, pairingToken: token, installDir: directory, nodeId: 'literal-node', authToken: token });
    for (const [name, command] of Object.entries(commands).filter(([name]) => !['windows', 'manualCompose'].includes(name))) {
      await fs.remove(path.join(root, 'args')); await fs.remove(path.join(root, 'urls'));
      await execFileAsync('/bin/sh', ['-c', command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_LOG: path.join(root, 'urls'), LAUNCH_LOG: path.join(root, 'args') }, timeout: 3000 });
      const args = (await fs.readFile(path.join(root, 'args'), 'utf8')).split('\0').filter(Boolean);
      assert.ok(args.includes(`--host=${url}`), name);
      assert.ok(args.includes('--node-id=literal-node'), name);
      if (name !== 'shell') assert.ok(args.includes(`--pairing=${token}`), name);
      if (name.startsWith('bareMetal')) assert.ok(args.includes(`--dir=${directory}`), name);
      assert.ok((await fs.readFile(path.join(root, 'urls'), 'utf8')).startsWith(`${url}/node/`), name);
    }
  } finally { await fs.remove(root); }
});

test('tool catalog includes node_bootstrap_info with no required baseUrl parameter', () => {
  const def = tools.definitions.find(def => def.name === 'node_bootstrap_info');
  assert.ok(def);
  assert.deepEqual(def?.parameters?.properties || {}, {});
});

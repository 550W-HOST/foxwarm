'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const root = path.dirname(__dirname);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-rid-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const env = { ...process.env, DOTNET_CLI_HOME: home, DOTNET_NOLOGO: 'true',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true' };
for (const key of Object.keys(env)) {
  if (/^(RuntimeIdentifier|MontyTargetRid|MontyExecutable|ArtifactTargetRid|NETCoreSdkRuntimeIdentifier|NETCoreSdkPortableRuntimeIdentifier)$/i.test(key)) {
    delete env[key];
  }
}
const dotnet = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet')
  : 'dotnet';

function evaluate(properties = {}) {
  // Evaluate the actual project and SDK imports without restoring, compiling or
  // acquiring native packages. No application configuration or state is loaded.
  const result = spawnSync(dotnet, ['msbuild', 'dotnet/Foxwarm/Foxwarm.csproj',
    '-nologo', '-nr:false',
    '-getProperty:RuntimeIdentifier,NETCoreSdkPortableRuntimeIdentifier,MontyTargetRid,MontyExecutable,ArtifactTargetRid',
    ...Object.entries(properties).map(([name, value]) => `-p:${name}=${value}`)],
  { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).Properties;
}

const ubuntuSdk = {
  NETCoreSdkRuntimeIdentifier: 'ubuntu.24.04-x64',
  NETCoreSdkPortableRuntimeIdentifier: 'linux-x64',
};

test('source native resources default to the installed SDK portable RID', () => {
  const actual = evaluate();
  assert.ok(actual.NETCoreSdkPortableRuntimeIdentifier);
  assert.equal(actual.RuntimeIdentifier, '');
  assert.equal(actual.MontyTargetRid, actual.NETCoreSdkPortableRuntimeIdentifier);
  assert.equal(actual.ArtifactTargetRid, actual.NETCoreSdkPortableRuntimeIdentifier);
});

test('a distro-specific Ubuntu SDK selects Linux x64 resources without a target override', () => {
  const actual = evaluate(ubuntuSdk);
  assert.equal(actual.RuntimeIdentifier, '');
  assert.equal(actual.MontyTargetRid, 'linux-x64');
  assert.equal(actual.MontyExecutable, 'monty');
  assert.equal(actual.ArtifactTargetRid, 'linux-x64');
});

test('an explicit Windows x64 target takes precedence over the SDK portable RID', () => {
  const actual = evaluate({ ...ubuntuSdk, RuntimeIdentifier: 'win-x64' });
  assert.equal(actual.MontyTargetRid, 'win-x64');
  assert.equal(actual.MontyExecutable, 'monty.exe');
  assert.equal(actual.ArtifactTargetRid, 'win-x64');
});

test('a musl SDK keeps its portable ABI and does not select the GNU Monty worker', () => {
  const actual = evaluate({
    NETCoreSdkRuntimeIdentifier: 'alpine.3.22-x64',
    NETCoreSdkPortableRuntimeIdentifier: 'linux-musl-x64',
  });
  assert.equal(actual.MontyTargetRid, 'linux-musl-x64');
  assert.equal(actual.MontyExecutable, '');
  assert.equal(actual.ArtifactTargetRid, 'linux-musl-x64');
});

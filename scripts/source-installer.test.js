'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-install-'));
  const bin = path.join(root, 'bin'), app = path.join(root, 'program with spaces'), data = path.join(root, 'data with spaces');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, '.git'), { recursive: true });
  const log = path.join(root, 'commands');
  // Keep the selected test Node when the isolated PATH excludes setup-node's bin.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FOXWARM_DIR: app,
    FOXWARM_DATA_DIR: data, FOXWARM_BRANCH: 'candidate', FOXWARM_TMUX_SESSION: 'installer-fixture', INSTALL_LOG: log,
    NODE_PATH: path.dirname(path.dirname(require.resolve('js-yaml/package.json'))) };
  function stub(name, content) { fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + content + '\n', { mode: 0o755 }); }
  stub('git', 'printf "git %s\\n" "$*" >> "$INSTALL_LOG"\nif [ "$1" = clone ]; then mkdir -p "${@: -1}/.git"; fi');
  stub('tmux', 'exit 1');
  stub('npm', 'printf "npm %s\\n" "$*" >> "$INSTALL_LOG"\nprintf "data %s\\n" "$FOXWARM_DATA_DIR" >> "$INSTALL_LOG"\n[ -s "$FOXWARM_DATA_DIR/state/token" ] || printf synthetic-install-token > "$FOXWARM_DATA_DIR/state/token"');
  stub('dotnet', 'case "$1" in --version) echo "${INSTALL_SDK:-10.0.100}";; --list-runtimes) echo "Microsoft.AspNetCore.App ${INSTALL_RUNTIME:-10.0.1} [fixture]";; *) exit 1;; esac');
  // Consume the piped source before returning the selected compiler result.
  stub('gcc', 'cat > /dev/null\nexit "${INSTALL_GCC_EXIT:-0}"');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function run(overrides = {}, args = [], cwd = root) {
    return spawnSync('/bin/bash', [path.join(__dirname, '../install-foxwarm.sh'), ...args], {
      cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
  }
  return { root, app, data, bin, log, run };
}
const unix = { skip: process.platform !== 'linux' && 'Linux source-installer qualification' };

test('source installer diagnoses the selected managed SDK/runtime before checkout or dependency changes', unix, t => {
  const f = fixture(t);
  for (const [env, diagnostic] of [
    [{ INSTALL_SDK: '8.0.100' }, /net10.0-capable/],
    [{ INSTALL_RUNTIME: '9.0.1' }, /ASP.NET Core 10 runtime is required/],
  ]) {
    const result = f.run(env);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, diagnostic);
    assert(!fs.existsSync(f.log), 'Prerequisite failure must precede checkout/build.');
  }
  fs.rmSync(path.join(f.bin, 'dotnet'));
  // Only the earlier prerequisite stubs are visible; system dotnet must be absent too.
  const missing = f.run({ PATH: f.bin });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\.NET 10 SDK/);
  assert(!fs.existsSync(f.log), 'Missing SDK must precede checkout/build.');
});

const dataSelections = [
  { name: 'fresh nested relative checkout uses its sibling', fresh: true, install: 'nested/program', expected: 'nested/foxwarm-data' },
  { name: 'existing checkout without a pointer retains checkout data', expected: 'program with spaces' },
  { name: 'existing checkout with a blank pointer retains checkout data', pointer: ' \r\n\t', expected: 'program with spaces' },
  { name: 'saved absolute path survives rerun', pointer: 'absolute', expected: 'saved data' },
  { name: 'saved relative path resolves from checkout, not caller', pointer: ' \t../saved data\r\n', expected: 'saved data' },
  { name: 'environment relative path overrides saved selection', pointer: '../saved data', env: 'environment data', expected: 'environment data' },
  { name: 'explicit relative path overrides environment and saved selection', pointer: '../saved data', env: 'environment data', explicit: 'explicit data', expected: 'explicit data' },
  { name: 'implicit current checkout retains saved path', pointer: '../saved data', cwd: 'app', expected: 'saved data' },
];

function prepareSelection(f, scenario) {
  const app = scenario.install ? path.join(f.root, scenario.install) : f.app;
  const selected = path.join(f.root, scenario.expected);
  if (scenario.fresh) fs.rmSync(f.app, { recursive: true });
  if (scenario.pointer !== undefined) {
    fs.writeFileSync(path.join(app, 'data_dir'), scenario.pointer === 'absolute'
      ? path.join(f.root, 'saved data') + '\n' : scenario.pointer);
  }
  // An existing root has configuration/token and user data that must be used, not replaced.
  if (!scenario.fresh) {
    fs.mkdirSync(path.join(selected, 'state'), { recursive: true });
    fs.writeFileSync(path.join(selected, 'state/token'), 'retained-install-token');
    fs.writeFileSync(path.join(selected, 'state/config.yaml'), 'bot:\n  httpPort: 31457\n');
    fs.writeFileSync(path.join(selected, 'user-data'), 'retained');
  }
  if (!scenario.fresh) fs.writeFileSync(path.join(f.app, 'package.json'), '{"name": "foxwarm"}');
  return { app, selected, cwd: scenario.cwd === 'app' ? app : f.root };
}

for (const scenario of dataSelections) {
  test(`Bash installer: ${scenario.name}`, unix, t => {
    const f = fixture(t);
    const { app, selected, cwd } = prepareSelection(f, scenario);
    const result = f.run({ FOXWARM_DIR: scenario.cwd ? '' : scenario.install || app,
      FOXWARM_DATA_DIR: scenario.env || '' }, scenario.explicit ? ['--data-dir', scenario.explicit] : [], cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(app, 'data_dir'), 'utf8').trim(), selected);
    assert(fs.readFileSync(f.log, 'utf8').split('\n').includes(`data ${selected}`));
    assert(result.stdout.includes(`Data dir:    ${selected}`));
    assert(result.stdout.includes(scenario.fresh ? '#token=synthetic-install-token' : ':31457/#token=retained-install-token'));
    if (!scenario.fresh) assert.equal(fs.readFileSync(path.join(selected, 'user-data'), 'utf8'), 'retained');
  });
}

const powershell = { skip: spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error && 'PowerShell is not installed' };
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";

function powershellFixture(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-install-ps-'));
  const app = path.join(root, 'program with spaces'), log = path.join(root, 'commands');
  fs.mkdirSync(path.join(app, '.git'), { recursive: true });
  const selection = prepareSelection({ root, app }, scenario);
  const harness = path.join(root, 'harness.ps1');
  fs.writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
function Record($Operation) {
  Add-Content -Path $env:INSTALL_LOG -Value "$Operation|$env:FOXWARM_DATA_DIR"
}
function git {
  if ($args[0] -eq 'clone') { New-Item -ItemType Directory -Force (Join-Path $args[-1] '.git') | Out-Null }
  $global:LASTEXITCODE = 0
}
function dotnet {
  if ($args[0] -eq '--version') { '10.0.100' } else { 'Microsoft.AspNetCore.App 10.0.1 [fixture]' }
  $global:LASTEXITCODE = 0
}
function python { $global:LASTEXITCODE = 0 }
function node {
  if ($args[0] -eq 'scripts/windowsService.js') {
    Record $args[1]
    $global:LASTEXITCODE = if ($args[1] -eq 'check-stopped' -and $env:INSTALL_RUNNING) { 1 } else { 0 }
  } else { & ${psQuote(process.execPath)} @args }
}
function npm {
  Record 'build'
  $token = Join-Path $env:FOXWARM_DATA_DIR 'state/token'
  if (-not (Test-Path $token)) { [IO.File]::WriteAllText($token, 'synthetic-install-token') }
  $global:LASTEXITCODE = 0
}
function Start-Process($FilePath) { Record $FilePath }
$parameters = @{}
${scenario.explicit ? `$parameters.DataDir = ${psQuote(scenario.explicit)}` : ''}
& ${psQuote(path.join(__dirname, '../install-foxwarm.ps1'))} @parameters
`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...selection, log, run(overrides = {}) {
    return spawnSync('pwsh', ['-NoProfile', '-File', harness], {
      cwd: selection.cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, FOXWARM_DIR: scenario.cwd ? '' : scenario.install || app,
        FOXWARM_DATA_DIR: scenario.env || '', FOXWARM_BRANCH: 'candidate',
        PROCESSOR_ARCHITECTURE: 'AMD64', INSTALL_LOG: log,
        NODE_PATH: path.dirname(path.dirname(require.resolve('js-yaml/package.json'))), ...overrides },
    });
  } };
}

for (const scenario of dataSelections) {
  test(`PowerShell installer: ${scenario.name}`, powershell, t => {
    const f = powershellFixture(t, scenario);
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(f.app, 'data_dir'), 'utf8').trim(), f.selected);
    const commands = fs.readFileSync(f.log, 'utf8').trim().split(/\r?\n/);
    assert.deepEqual(commands.slice(0, 3), ['check-stopped', 'build', 'start'].map(command => `${command}|${f.selected}`));
    const url = scenario.fresh ? 'http://localhost:3001/#token=synthetic-install-token'
      : 'http://localhost:31457/#token=retained-install-token';
    assert.equal(commands[3], `${url}|${f.selected}`);
    if (!scenario.fresh) assert.equal(fs.readFileSync(path.join(f.selected, 'user-data'), 'utf8'), 'retained');
  });
}

test('PowerShell installer checks the saved data identity and stops before building a running instance', powershell, t => {
  const f = powershellFixture(t, { pointer: '../saved data', expected: 'saved data' });
  const result = f.run({ INSTALL_RUNNING: '1' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Foxwarm must be stopped/);
  assert.equal(fs.readFileSync(f.log, 'utf8').trim(), `check-stopped|${f.selected}`);
});

test('source installer retains branch, spaced paths, data pointer and OOBE with a compatible later SDK', unix, t => {
  const f = fixture(t);
  const result = f.run({ INSTALL_SDK: '11.0.100' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(f.app, 'data_dir'), 'utf8'), f.data + '\n');
  const commands = fs.readFileSync(f.log, 'utf8');
  assert.match(commands, /fetch origin candidate/);
  assert.match(commands, /pull --ff-only origin candidate/);
  assert.match(commands, /npm start/);
  assert.match(result.stdout, /#token=synthetic-install-token/);
});

test('source installer diagnoses missing PTY development files before npm startup', unix, t => {
  const f = fixture(t);
  const result = f.run({ INSTALL_GCC_EXIT: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pty.h and libutil development files/);
  assert(!fs.readFileSync(f.log, 'utf8').includes('npm '));
});

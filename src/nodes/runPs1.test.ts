import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUN_PS1 = path.resolve(__dirname, '../../templates/node/run.ps1');

test('run.ps1 anchors node cwd and agent storage outside the caller project', {
  skip: process.platform !== 'win32',
}, async () => {
  const fixtureRoot = path.resolve(__dirname, '../../test/.temp');
  await fs.ensureDir(fixtureRoot);
  const root = await fs.mkdtemp(path.join(fixtureRoot, 'foxwarm-run-ps1-'));
  const scriptDir = path.join(root, 'foxwarm node');
  const callerProject = path.join(root, 'caller project');
  const stateDir = path.join(scriptDir, 'data');
  const sourceDir = path.join(scriptDir, 'source');
  const capturePath = path.join(root, 'node-capture.json');
  const scriptPath = path.join(scriptDir, 'run.ps1');
  const harnessPath = path.join(root, 'harness.ps1');
  try {
    await Promise.all([fs.ensureDir(scriptDir), fs.ensureDir(callerProject)]);
    await fs.copyFile(RUN_PS1, scriptPath);
    await fs.writeFile(harnessPath, [
      'param([string]$RunPs1, [string]$StateDir, [string]$SourceDir, [string]$CapturePath)',
      'function Invoke-WebRequest {',
      '  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)',
      '  New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null',
      '  Set-Content -LiteralPath $OutFile -Value "fixture"',
      '}',
      'function tar {',
      '  $targetIndex = [Array]::IndexOf($args, "-C") + 1',
      '  $target = $args[$targetIndex]',
      '  $bundle = Join-Path $target "packages\\cli-node\\dist\\client.bundle.js"',
      '  New-Item -ItemType Directory -Force -Path (Split-Path $bundle) | Out-Null',
      '  Set-Content -LiteralPath $bundle -Value "fixture"',
      '  & $env:ComSpec /d /c exit 0',
      '}',
      'function node {',
      '  [PSCustomObject]@{',
      '    cwd = (Get-Location).Path',
      '    agentsDir = $env:FOXWARM_AGENTS_DIR',
      '    agentDir = $env:FOXWARM_AGENT_DIR',
      '    args = @($args)',
      '  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $CapturePath',
      '  & $env:ComSpec /d /c exit 0',
      '}',
      '& $RunPs1 -HostUrl "http://master.test" -Pairing "TOKEN" -NodeId "windows-node" -StateDir $StateDir -SourceDir $SourceDir',
    ].join('\r\n'));

    const env = { ...process.env };
    env.FOXWARM_AGENT_DIR = 'hostile-single-agent';
    env.FOXWARM_AGENTS_DIR = 'hostile-agents-root';
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', harnessPath,
      '-RunPs1', scriptPath,
      '-StateDir', stateDir,
      '-SourceDir', sourceDir,
      '-CapturePath', capturePath,
    ], { cwd: callerProject, env, timeout: 15_000 });

    const capture = await fs.readJson(capturePath);
    assert.equal((await fs.realpath(capture.cwd)).toLowerCase(), (await fs.realpath(scriptDir)).toLowerCase());
    assert.equal(
      (await fs.realpath(capture.agentsDir)).toLowerCase(),
      (await fs.realpath(path.join(stateDir, 'agents'))).toLowerCase(),
    );
    assert.equal(capture.agentDir, null);
    assert.equal(await fs.pathExists(path.join(callerProject, 'agents')), false);
    assert.ok(capture.args.includes(path.join(stateDir, 'state', 'node_credentials.json')));
  } finally {
    await fs.remove(root);
  }
});
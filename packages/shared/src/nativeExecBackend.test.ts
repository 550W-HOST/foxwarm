import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'fs-extra';
import { nativeProcessOperations } from './processOperations';
import { PersistentExecManager, type PersistentExecManagerOptions } from './persistentExec';

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await fs.pathExists(filePath)) {
    if (Date.now() > deadline) throw new Error('Candidate process did not publish its marker.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

test('native launch connects stdout and stderr to one inherited file without a parent output pump', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-inherited-output-'));
  const outputPath = path.join(root, 'output.log');
  const done = path.join(root, 'done');
  try {
    await nativeProcessOperations.launch({
      command: process.execPath,
      args: ['-e', `const fs = require('fs'); fs.writeSync(1, 'stdout 中文\\n'); fs.writeSync(2, 'stderr 中文\\n'); fs.writeFileSync(${JSON.stringify(done)}, 'done');`],
      cwd: root, env: process.env, detached: false, windowsHide: true, outputPath,
    });
    await waitForFile(done);
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'stdout 中文\nstderr 中文\n');
    // Starting another command at an existing capture must not truncate it.
    await assert.rejects(nativeProcessOperations.launch({
      command: process.execPath, args: ['-e', 'process.exit(0)'],
      cwd: root, env: process.env, detached: false, windowsHide: true, outputPath,
    }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(outputPath, 'utf8'), 'stdout 中文\nstderr 中文\n');
    const failedOutput = path.join(root, 'failed.log');
    await assert.rejects(nativeProcessOperations.launch({
      command: path.join(root, 'missing-executable'), args: [],
      cwd: root, env: process.env, detached: false, windowsHide: true, outputPath: failedOutput,
    }), { code: 'ENOENT' });
    // The failed launch must release the parent's handle (also on Windows).
    await fs.remove(failedOutput);
  } finally {
    await fs.remove(root);
  }
});

test('Windows PowerShell captures Unicode script, host and native output with UTF-8 cwd and exit sidecars', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-powershell-capture-'));
  const cwd = path.join(root, '中文 目录');
  const finalCwd = path.join(root, '最终 目录');
  const nativeScript = path.join(cwd, '原生 输出.js');
  const manager = new PersistentExecManager({ getDefaultCwd: () => cwd, getExecTempDir: () => path.join(root, 'exec') });
  try {
    await fs.ensureDir(cwd);
    await fs.ensureDir(finalCwd);
    await fs.writeFile(nativeScript, `process.stdout.write('native stdout 中文\\n'); process.stderr.write('native stderr 中文\\n'); process.exitCode = 7;`, 'utf8');
    const entry = await manager.startPersistentExec({ command: [
      "Write-Output 'success 中文'",
      "Write-Host 'host 中文'",
      "[Console]::Out.WriteLine('console stdout 中文')",
      "[Console]::Error.WriteLine('console stderr 中文')",
      "Write-Warning 'warning 中文'",
      `& $env:FOXWARM_EXEC_NODE_PATH ${psLiteral(nativeScript)}`,
      `Set-Location -LiteralPath ${psLiteral(finalCwd)}`,
    ].join('\r\n') });
    const status = await manager.waitForExecCompletion(entry.id, 10_000);
    assert.ok(status);
    assert.equal(status.exitCode, 7);
    assert.equal(await manager.readFinishedExecWorkingDirectory(entry), finalCwd);
    const capture = await fs.readFile(entry.logPath, 'utf8');
    for (const expected of ['success 中文', 'host 中文', 'console stdout 中文', 'console stderr 中文', 'warning 中文', 'native stdout 中文', 'native stderr 中文']) {
      assert.ok(capture.includes(expected), `Missing captured text: ${expected}`);
    }
    assert.doesNotMatch(capture, /Transcript|transcript|Windows PowerShell|#< CLIXML|\uFFFD/);
    const display = await manager.buildForegroundExecResult(entry, status);
    const data = await manager.buildProgrammaticExecResult(entry, status, display);
    assert.equal(data.content, capture);
    assert.equal(data.truncated, false);
    assert.match(display, /Exit code: 7/);
    // Both generated scripts must be decodable by Windows PowerShell 5.1,
    // independently of the system ANSI code page. Sidecars use UTF-8 without BOM.
    for (const suffix of ['.command.ps1', '.user.ps1']) {
      const bytes = await fs.readFile(path.join(path.dirname(entry.logPath), `${entry.id}${suffix}`));
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    }
    assert.equal(await fs.readFile(entry.cwdPath!, 'utf8'), finalCwd);
    assert.equal(JSON.parse(await fs.readFile(entry.statusPath!, 'utf8')).exitCode, 7);
    await manager.finalizeForegroundExec(entry.id);

    const inputScript = path.join(cwd, '管道 输入.js');
    await fs.writeFile(inputScript, `let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => process.stdout.write(input));`, 'utf8');
    const input = await manager.startPersistentExec({ command: `'管道 中文' | & $env:FOXWARM_EXEC_NODE_PATH ${psLiteral(inputScript)}` });
    const inputStatus = await manager.waitForExecCompletion(input.id, 10_000);
    assert.equal(inputStatus?.exitCode, 0);
    assert.equal((await fs.readFile(input.logPath, 'utf8')).trim(), '管道 中文');
    await manager.finalizeForegroundExec(input.id);

    const failure = await manager.startPersistentExec({ command: "throw 'failure 中文'" });
    const failureStatus = await manager.waitForExecCompletion(failure.id, 10_000);
    assert.equal(failureStatus?.exitCode, 1);
    assert.match(await fs.readFile(failure.logPath, 'utf8'), /failure 中文/);
    await manager.finalizeForegroundExec(failure.id);
    const explicitExit = await manager.startPersistentExec({ command: 'exit 9' });
    assert.equal((await manager.waitForExecCompletion(explicitExit.id, 10_000))?.exitCode, 9);
    assert.equal((await fs.stat(explicitExit.logPath)).size, 0);
    await manager.finalizeForegroundExec(explicitExit.id);
  } finally {
    await manager.shutdown();
    await fs.remove(root);
  }
});

test('Windows background capture survives wait cancellation and manager recovery until acknowledged completion', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-powershell-background-'));
  const ready = path.join(root, 'ready');
  const release = path.join(root, 'release');
  const registryPath = path.join(root, 'running-exec.json');
  let acceptDelivery = false;
  let deliveries = 0;
  const options: PersistentExecManagerOptions = {
    getDefaultCwd: () => root, getExecTempDir: () => path.join(root, 'exec'), registryPath,
    completionDispatcher: async (entry, status) => {
      deliveries += 1;
      assert.equal(entry.completionCapability, 'fixture-capability');
      assert.equal(status.exitCode, 0);
      assert.match(await fs.readFile(entry.logPath, 'utf8'), /finished 中文/);
      if (!acceptDelivery) throw new Error('Fixture completion is not acknowledged yet.');
    },
  };
  const manager = new PersistentExecManager(options);
  const recovered = new PersistentExecManager(options);
  let entry: Awaited<ReturnType<PersistentExecManager['startPersistentExec']>> | undefined;
  try {
    await manager.initialize();
    entry = await manager.startPersistentExec({ sessionId: 'fixture/session', completionCapability: 'fixture-capability', command: [
      "[Console]::WriteLine('partial 中文')",
      `[System.IO.File]::WriteAllText(${psLiteral(ready)}, 'ready')`,
      `while (!(Test-Path -LiteralPath ${psLiteral(release)})) { Start-Sleep -Milliseconds 25 }`,
      "[Console]::Error.WriteLine('finished 中文')",
    ].join('\r\n') });
    await waitForFile(ready);
    assert.equal(await manager.waitForExecCompletion(entry.id, 50), null);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await manager.waitForExecCompletion(entry.id, 10_000, controller.signal), null);
    const partial = await manager.buildBackgroundTimeoutResult(entry, 1, undefined, 'Stop');
    assert.match(partial, /partial 中文/);
    assert.ok(partial.includes(`execId: ${entry.id}`));
    await manager.markExecForBackgroundNotification(entry.id);
    await manager.shutdown();
    await recovered.initialize();
    assert.ok(recovered.getRunningExec(entry.id));
    await fs.writeFile(release, 'release');
    assert.equal((await recovered.waitForExecCompletion(entry.id, 10_000))?.exitCode, 0);
    await recovered.reconcileNow();
    assert.ok(deliveries >= 1);
    assert.equal((await fs.readJson(registryPath)).execs.length, 1);
    const failedDeliveries = deliveries;
    acceptDelivery = true;
    await recovered.reconcileNow();
    assert.equal(deliveries, failedDeliveries + 1);
    assert.equal((await fs.readJson(registryPath)).execs.length, 0);
    assert.match(await fs.readFile(entry.logPath, 'utf8'), /partial 中文[\s\S]*finished 中文/);
  } finally {
    await fs.writeFile(release, 'release');
    if (entry) await (recovered.getRunningExec(entry.id) ? recovered : manager).waitForExecCompletion(entry.id, 10_000);
    await manager.shutdown();
    await recovered.shutdown();
    await fs.remove(root);
  }
});

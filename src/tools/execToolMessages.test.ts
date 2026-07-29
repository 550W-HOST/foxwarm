import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as execManager from '../execManager';
import { buildBackgroundTimeoutResult, buildForegroundExecResult, finalizeForegroundExec, startPersistentExec, waitForExecCompletion, type RunningExecEntry } from '../execManager';
import { getAgentDir } from '../config';
import { definitions, exec, read } from '../tools';

function buildExecEntry(logPath: string, overrides: Partial<RunningExecEntry> = {}): RunningExecEntry {
  return {
    id: 'exec_test',
    pid: 4321,
    sessionId: 'session-test',
    agentName: 'main',
    nodeId: 'master',
    command: 'echo test',
    initialCwd: process.cwd(),
    logPath,
    statusPath: `${logPath}.exit.json`,
    cwdPath: `${logPath}.cwd.txt`,
    startedAt: Date.now(),
    notifyOnCompletion: false,
    ...overrides,
  };
}

test('exec schema documents timeout clamping without rejecting values above the maximum', () => {
  const def = definitions.find((entry) => entry.name === 'exec');
  assert.ok(def);
  const timeout = (def?.parameters?.properties as any)?.timeout;
  assert.ok(timeout);
  assert.equal(timeout.type, 'number');
  assert.equal(timeout.minimum, execManager.MIN_EXEC_TIMEOUT_SECONDS);
  assert.equal(Object.prototype.hasOwnProperty.call(timeout, 'maximum'), false);
  assert.match(String(timeout.description), /default: 15/i);
  assert.match(String(timeout.description), /above the 60s maximum are clamped/i);
  assert.match(String(def?.description), /do not add \| head or \| tail merely to limit context/i);
  assert.match(String(def?.description), /filtering changes what the command log captures/i);
  assert.match(String(def?.description), /outstanding background process/i);
  assert.match(String(def?.description), /if you continue other work instead of waiting, remember it is still running/i);
});

test('exec tool still rejects timeout values below the allowed range', async () => {
  await assert.rejects(
    () => exec({ command: 'echo hi', timeout: 0 }, { session: { agent: 'main' } } as any),
    /timeout must be between 1 and 60 seconds/i,
  );
});

test('exec tool rejects non-finite numeric timeout values', async () => {
  for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(
      () => exec({ command: 'echo hi', timeout }, { session: { agent: 'main' } } as any),
      /timeout must be a number between 1 and 60 seconds/i,
    );
  }
});

test('exec tool passes timeout through to waitForExecCompletion and background result builder', async () => {
  const originalStartPersistentExec = execManager.startPersistentExec;
  const originalWaitForExecCompletion = execManager.waitForExecCompletion;
  const originalReadLiveExecWorkingDirectory = execManager.readLiveExecWorkingDirectory;
  const originalMarkExecForBackgroundNotification = execManager.markExecForBackgroundNotification;
  const originalBuildBackgroundTimeoutResult = execManager.buildBackgroundTimeoutResult;

  const fakeEntry = buildExecEntry('/tmp/exec-timeout-forwarding.log', { sessionId: undefined });
  let seenTimeoutMs: number | null = null;
  let seenBackgroundTimeoutSeconds: number | null = null;

  try {
    (execManager as any).startPersistentExec = async (): Promise<RunningExecEntry> => fakeEntry;
    (execManager as any).waitForExecCompletion = async (_execId: string, timeoutMs: number): Promise<null> => {
      seenTimeoutMs = timeoutMs;
      return null;
    };
    (execManager as any).readLiveExecWorkingDirectory = async (): Promise<null> => null;
    (execManager as any).markExecForBackgroundNotification = async (): Promise<RunningExecEntry> => fakeEntry;
    (execManager as any).buildBackgroundTimeoutResult = async (_entry: RunningExecEntry, timeoutSeconds: number): Promise<string> => {
      seenBackgroundTimeoutSeconds = timeoutSeconds;
      return `background timeout ${timeoutSeconds}`;
    };

    const result = await exec({ command: 'sleep 1', timeout: 7 }, { session: { agent: 'main' } } as any);
    assert.equal(result, 'background timeout 7');
    assert.equal(seenTimeoutMs, 7000);
    assert.equal(seenBackgroundTimeoutSeconds, 7);
  } finally {
    (execManager as any).startPersistentExec = originalStartPersistentExec;
    (execManager as any).waitForExecCompletion = originalWaitForExecCompletion;
    (execManager as any).readLiveExecWorkingDirectory = originalReadLiveExecWorkingDirectory;
    (execManager as any).markExecForBackgroundNotification = originalMarkExecForBackgroundNotification;
    (execManager as any).buildBackgroundTimeoutResult = originalBuildBackgroundTimeoutResult;
  }
});

test('exec tool clamps oversized finite timeouts to 60s and forwards a footer warning', async () => {
  const originalStartPersistentExec = execManager.startPersistentExec;
  const originalWaitForExecCompletion = execManager.waitForExecCompletion;
  const originalReadLiveExecWorkingDirectory = execManager.readLiveExecWorkingDirectory;
  const originalMarkExecForBackgroundNotification = execManager.markExecForBackgroundNotification;
  const originalBuildBackgroundTimeoutResult = execManager.buildBackgroundTimeoutResult;
  const fakeEntry = buildExecEntry('/tmp/exec-timeout-clamp.log', { sessionId: undefined });
  const seen: Array<{ timeoutMs: number; timeoutSeconds: number; warning?: string }> = [];

  try {
    (execManager as any).startPersistentExec = async (): Promise<RunningExecEntry> => fakeEntry;
    (execManager as any).waitForExecCompletion = async (_execId: string, timeoutMs: number): Promise<null> => {
      seen.push({ timeoutMs, timeoutSeconds: -1 });
      return null;
    };
    (execManager as any).readLiveExecWorkingDirectory = async (): Promise<null> => null;
    (execManager as any).markExecForBackgroundNotification = async (): Promise<RunningExecEntry> => fakeEntry;
    (execManager as any).buildBackgroundTimeoutResult = async (_entry: RunningExecEntry, timeoutSeconds: number, warning?: string): Promise<string> => {
      const current = seen.at(-1)!;
      current.timeoutSeconds = timeoutSeconds;
      current.warning = warning;
      return warning || '';
    };

    for (const requested of [61, 120, Number.MAX_VALUE]) {
      const result = String(await exec({ command: 'sleep 1', timeout: requested }, { session: { agent: 'main' } } as any));
      assert.equal(seen.at(-1)?.timeoutMs, 60_000);
      assert.equal(seen.at(-1)?.timeoutSeconds, 60);
      assert.match(result, new RegExp(`^WARNING: Requested timeout ${String(requested).replace('+', '\\+')}s exceeds the 60s maximum; using 60s\\.$`));
    }
  } finally {
    (execManager as any).startPersistentExec = originalStartPersistentExec;
    (execManager as any).waitForExecCompletion = originalWaitForExecCompletion;
    (execManager as any).readLiveExecWorkingDirectory = originalReadLiveExecWorkingDirectory;
    (execManager as any).markExecForBackgroundNotification = originalMarkExecForBackgroundNotification;
    (execManager as any).buildBackgroundTimeoutResult = originalBuildBackgroundTimeoutResult;
  }
});

test('persistent exec expands cwd ~ using local home directory', async () => {
  let execId: string | null = null;

  try {
    const entry = await startPersistentExec({
      command: 'pwd',
      agentName: 'main',
      cwd: '~',
    });
    execId = entry.id;

    const status = await waitForExecCompletion(entry.id, 5000);
    assert.ok(status, 'exec should finish during test timeout');
    const result = await buildForegroundExecResult(entry, status);
    assert.match(result, new RegExp(`^${os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n---\nExit code: 0`));
  } finally {
    if (execId) {
      await finalizeForegroundExec(execId).catch(() => {});
    }
  }
});

test('persistent exec rejects missing cwd with a friendly cwd-focused error and does not create it', async () => {
  const missing = path.join(os.tmpdir(), `foxwarm-missing-local-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.remove(missing).catch(() => {});

  await assert.rejects(
    () => startPersistentExec({
      command: 'pwd',
      agentName: 'main',
      cwd: missing,
    }),
    (err: any) => {
      const message = String(err?.message || err);
      assert.match(message, /working directory is invalid/i);
      assert.match(message, /Source: explicit/i);
      assert.match(message, /Raw cwd/i);
      assert.match(message, /Resolved cwd/i);
      assert.match(message, /not a missing `\/bin\/bash`/i);
      return true;
    },
  );

  assert.equal(await fs.pathExists(missing), false, 'missing cwd should not be auto-created');
});

test('background exec timeout result uses partial output followed by a metadata footer, process tree, pid, and log path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-timeout-'));
  const logPath = path.join(tempDir, 'command.log');

  try {
    await fs.writeFile(logPath, 'hello from partial output\n');
    const result = await buildBackgroundTimeoutResult(buildExecEntry(logPath), 7);

    assert.ok(result.startsWith('Partial Output:\nhello from partial output'));
    assert.match(result, /\n---\n\[Process running longer than 7s\] Switched to background\./);
    assert.match(result, /continue other work, remember this process remains outstanding until its completion message arrives/i);
    assert.ok(result.indexOf('PID: 4321') > result.indexOf('Wait for notification'));
    assert.match(result, /Process tree \(best-effort live snapshot; managed shell-script root PID 4321\):/);
    assert.ok(result.endsWith(`Log file: ${logPath}`));
  } finally {
    await fs.remove(tempDir);
  }
});

test('foreground exec truncated output keeps line-aware excerpt and footer metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-truncated-'));
  const logPath = path.join(tempDir, 'command.log');
  const head = 'A'.repeat(12000);
  const tail = 'B'.repeat(12000);

  try {
    await fs.writeFile(logPath, `${head}${tail}`);
    const result = await buildForegroundExecResult(
      buildExecEntry(logPath),
      { exitCode: 0, finishedAt: new Date().toISOString() },
    );

    assert.match(result, /\[foxwarm: line too long/);
    assert.match(result, /A{100}/);
    assert.match(result, /B{100}/);
    assert.match(result, new RegExp(`---\nExit code: 0\nCommand output saved to: ${logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(result, /Foxwarm placeholders above .* are not original output content/);
    assert.match(result, /Original output: 1 line\(s\), 24000 character\(s\)\./);
  } finally {
    await fs.remove(tempDir);
  }
});

test('foreground exec warning remains in the footer when command output is truncated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-warning-truncated-'));
  const logPath = path.join(tempDir, 'command.log');
  const warning = 'WARNING: Requested timeout 120s exceeds the 60s maximum; using 60s.';

  try {
    await fs.writeFile(logPath, 'x'.repeat(24000));
    const result = await buildForegroundExecResult(
      buildExecEntry(logPath),
      { exitCode: 1, finishedAt: new Date().toISOString(), error: 'test failure' },
      warning,
    );

    assert.match(result, /---\nExit code: 1\nError: test failure\nWARNING: Requested timeout 120s exceeds the 60s maximum; using 60s\./);
    assert.match(result, /Command output saved to:/);
  } finally {
    await fs.remove(tempDir);
  }
});

test('background timeout result includes oversized-timeout warning with final metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-warning-background-'));
  const logPath = path.join(tempDir, 'command.log');
  const warning = 'WARNING: Requested timeout 120s exceeds the 60s maximum; using 60s.';

  try {
    await fs.writeFile(logPath, 'partial\n');
    const result = await buildBackgroundTimeoutResult(buildExecEntry(logPath), 60, warning);
    assert.match(result, /\[Process running longer than 60s\]/);
    assert.match(result, /WARNING: Requested timeout 120s exceeds the 60s maximum; using 60s\.\nPID: 4321/);
    assert.ok(result.endsWith(`Log file: ${logPath}`));
  } finally {
    await fs.remove(tempDir);
  }
});

test('read tool returns full content for unified output guard', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-read-truncated-'));
  const filePath = path.join(tempDir, 'large.txt');

  try {
    await fs.writeFile(filePath, 'a'.repeat(40000));
    const result = await read({ filePath }, { session: { agent: 'main' } } as any);

    assert.equal(String(result), 'a'.repeat(40000));
  } finally {
    await fs.remove(tempDir);
  }
});

test('persistent exec log files use compact time-and-pid filenames under the date directory', async () => {
  const agentName = `exec_log_name_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentDir = getAgentDir(agentName);
  let execId: string | null = null;

  try {
    await fs.ensureDir(agentDir);
    const entry = await startPersistentExec({
      command: 'echo compact-log-name-test',
      agentName,
    });
    execId = entry.id;

    const status = await waitForExecCompletion(entry.id, 5000);
    assert.ok(status, 'exec should finish during test timeout');

    const logBaseName = path.basename(entry.logPath);
    assert.match(logBaseName, /^\d{9}_pid\d+(?:_\d+)?\.log$/);
    assert.match(entry.logPath, /[\\/]\.temp[\\/]exec[\\/]\d{4}-\d{2}-\d{2}[\\/]/);
    assert.match(logBaseName, new RegExp(`_pid${entry.pid}(?:_\\d+)?\\.log$`));
    assert.equal(entry.statusPath, `${entry.logPath}.exit.json`);
    assert.equal(entry.cwdPath, `${entry.logPath}.cwd.txt`);
    assert.equal(await fs.pathExists(entry.logPath), true);
  } finally {
    if (execId) {
      await finalizeForegroundExec(execId).catch(() => {});
    }
    await fs.remove(agentDir);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as execManager from './execManager';
import { buildBackgroundTimeoutResult, buildForegroundExecResult, type RunningExecEntry } from './execManager';
import { definitions, exec, read } from './tools';

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

test('exec schema exposes timeout with documented range and default', () => {
  const def = definitions.find((entry) => entry.name === 'exec');
  assert.ok(def);
  const timeout = (def?.parameters?.properties as any)?.timeout;
  assert.ok(timeout);
  assert.equal(timeout.type, 'number');
  assert.equal(timeout.minimum, execManager.MIN_EXEC_TIMEOUT_SECONDS);
  assert.equal(timeout.maximum, execManager.MAX_EXEC_TIMEOUT_SECONDS);
  assert.match(String(timeout.description), /default: 15/i);
  assert.match(String(timeout.description), /1-60/i);
});

test('exec tool rejects timeout values outside the allowed range', async () => {
  await assert.rejects(
    () => exec({ command: 'echo hi', timeout: 0 }, { session: { agent: 'main' } } as any),
    /timeout must be between 1 and 60 seconds/i,
  );

  await assert.rejects(
    () => exec({ command: 'echo hi', timeout: 61 }, { session: { agent: 'main' } } as any),
    /timeout must be between 1 and 60 seconds/i,
  );
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

test('background exec timeout result uses short header, body, then full footer notice with pid and log path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-exec-timeout-'));
  const logPath = path.join(tempDir, 'command.log');

  try {
    await fs.writeFile(logPath, 'hello from partial output\n');
    const result = await buildBackgroundTimeoutResult(buildExecEntry(logPath), 7);

    assert.ok(result.startsWith('[Process running longer than 7s]'));
    assert.match(result, /\n\nPartial Output:\nhello from partial output/i);
    assert.match(result, /\n\n\[Process running longer than 7s\] Switched to background\./);
    assert.ok(result.indexOf('PID: 4321') > result.indexOf('Wait for notification'));
    assert.ok(result.endsWith(`Log file: ${logPath}`));
  } finally {
    await fs.remove(tempDir);
  }
});

test('foreground exec truncated output is wrapped with repeated notices and keeps full-output path at the end', async () => {
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

    assert.ok(result.startsWith('[OUTPUT TOO LONG]'));
    assert.match(result, /\[\.\.\.TRUNCATED\.\.\.\]/);
    assert.match(result, /A{100}/);
    assert.match(result, /B{100}/);
    assert.ok(result.endsWith(`[OUTPUT TOO LONG] Full output saved to: ${logPath}`));
  } finally {
    await fs.remove(tempDir);
  }
});

test('read tool truncated output is wrapped with opening and closing notices', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-read-truncated-'));
  const filePath = path.join(tempDir, 'large.txt');

  try {
    await fs.writeFile(filePath, 'a'.repeat(40000));
    const result = await read({ filePath }, { session: { agent: 'main' } } as any);

    assert.match(String(result), /^\[TOO LONG \(~\d+ tokens\)\]\n\n/);
    assert.match(String(result), /a{100}/);
    assert.match(String(result), /\n\n\[TOO LONG \(~\d+ tokens\)\] TRUNCATED\. Showing first 10000 chars only\.$/);
  } finally {
    await fs.remove(tempDir);
  }
});

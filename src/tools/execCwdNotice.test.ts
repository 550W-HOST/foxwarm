import test from 'node:test';
import assert from 'node:assert/strict';
import * as execManager from '../execManager';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { exec } from '../tools';
import type { RunningExecEntry } from '../execManager';

function buildExecEntry(overrides: Partial<RunningExecEntry> = {}): RunningExecEntry {
  const logPath = '/tmp/exec-cwd-notice.log';
  return {
    id: 'exec_cwd_notice_test',
    pid: 4321,
    sessionId: 'session-cwd-notice',
    agentName: 'main',
    nodeId: 'master',
    command: 'cd /tmp/after',
    initialCwd: '/tmp/before',
    logPath,
    statusPath: `${logPath}.exit.json`,
    cwdPath: `${logPath}.cwd.txt`,
    startedAt: Date.now(),
    notifyOnCompletion: false,
    ...overrides,
  };
}

test('exec cwd change notice is appended and names subsequent default-cwd tools', async () => {
  const originalStartPersistentExec = execManager.startPersistentExec;
  const originalWaitForExecCompletion = execManager.waitForExecCompletion;
  const originalReadFinishedExecWorkingDirectory = execManager.readFinishedExecWorkingDirectory;
  const originalBuildForegroundExecResult = execManager.buildForegroundExecResult;
  const originalFinalizeForegroundExec = execManager.finalizeForegroundExec;
  const originalSaveSession = sessionManager.saveSession;
  const originalUpdateSettings = sessionRuntime.updateSettings;

  const fakeEntry = buildExecEntry();

  try {
    (execManager as any).startPersistentExec = async (): Promise<RunningExecEntry> => fakeEntry;
    (execManager as any).waitForExecCompletion = async (): Promise<{ exitCode: number; finishedAt: string }> => ({
      exitCode: 0,
      finishedAt: new Date().toISOString(),
    });
    (execManager as any).readFinishedExecWorkingDirectory = async (): Promise<string> => '/tmp/after';
    (execManager as any).buildForegroundExecResult = async (): Promise<string> => 'command output';
    (execManager as any).finalizeForegroundExec = async (): Promise<void> => {};
    (sessionManager as any).saveSession = async (): Promise<void> => {};
    (sessionRuntime as any).updateSettings = async () => ({
      previous: { cwd: '/tmp/before' },
      current: { cwd: '/tmp/after' },
      changed: ['cwd'],
    });

    const result = String(await exec({ command: 'cd /tmp/after', timeout: 5 }, {
      sessionId: 'session-cwd-notice',
      session: { id: 'session-cwd-notice', agent: 'main', cwd: '/tmp/before' },
    } as any));

    assert.ok(result.startsWith('command output'));
    assert.match(result, /\n\nSESSION CWD CHANGED: `\/tmp\/before` → `\/tmp\/after`\./);
    assert.match(result, /default cwd for subsequent exec\/read\/edit\/write\/apply_patch tool calls/);
    assert.equal(result.indexOf('SESSION CWD CHANGED'), result.lastIndexOf('SESSION CWD CHANGED'));
    assert.ok(result.indexOf('SESSION CWD CHANGED') > result.indexOf('command output'));
  } finally {
    (execManager as any).startPersistentExec = originalStartPersistentExec;
    (execManager as any).waitForExecCompletion = originalWaitForExecCompletion;
    (execManager as any).readFinishedExecWorkingDirectory = originalReadFinishedExecWorkingDirectory;
    (execManager as any).buildForegroundExecResult = originalBuildForegroundExecResult;
    (execManager as any).finalizeForegroundExec = originalFinalizeForegroundExec;
    (sessionManager as any).saveSession = originalSaveSession;
    (sessionRuntime as any).updateSettings = originalUpdateSettings;
  }
});

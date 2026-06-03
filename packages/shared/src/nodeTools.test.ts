import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { exec, read, write } from './nodeTools';
import { getNodeAgentDir } from './nodeFileTransfer';

function uniqueAgent(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupAgent(agentName: string) {
  await fs.remove(getNodeAgentDir(agentName)).catch(() => {});
}

test('node read treats startLine/endLine 0 as omitted', async () => {
  const agentName = uniqueAgent('node_read_zero');
  const baseDir = getNodeAgentDir(agentName);
  const filePath = path.join(baseDir, 'note.txt');
  try {
    await fs.ensureDir(baseDir);
    await fs.writeFile(filePath, 'one\ntwo\nthree');
    assert.equal(await read({ filePath: 'note.txt', startLine: 0, endLine: 0 }, { session: { agent: agentName } }), 'one\ntwo\nthree');
    assert.equal(await read({ filePath: 'note.txt', startLine: 2, endLine: 0 }, { session: { agent: agentName } }), 'two\nthree');
  } finally {
    await cleanupAgent(agentName);
  }
});

test('node write requires existing parent dirs unless createDirs=true', async () => {
  const agentName = uniqueAgent('node_write_mkdir');
  const baseDir = getNodeAgentDir(agentName);
  try {
    await fs.ensureDir(baseDir);
    await assert.rejects(
      () => write({ filePath: 'missing/child/note.txt', content: 'hello' }, { session: { agent: agentName } }),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.match(message, /Parent directory does not exist/);
        assert.match(message, /missing/);
        assert.match(message, /createDirs=true/);
        return true;
      },
    );
    await write({ filePath: 'missing/child/note.txt', content: 'hello', createDirs: true }, { session: { agent: agentName } });
    assert.equal(await fs.readFile(path.join(baseDir, 'missing', 'child', 'note.txt'), 'utf8'), 'hello');
  } finally {
    await cleanupAgent(agentName);
  }
});

test('node exec expands cwd ~ on the executing node', async () => {
  const agentName = uniqueAgent('node_exec_home');
  try {
    const result = await exec(
      { command: 'pwd', cwd: '~', timeout: 5 },
      { sessionId: 'shared-node-test-home', session: { agent: agentName, currentNode: 'test-node' }, runtimeNodeId: 'test-node' },
    );
    assert.equal(String(result).trim(), os.homedir());
  } finally {
    await cleanupAgent(agentName);
  }
});

test('node exec rejects missing cwd with a friendly cwd-focused error', async () => {
  const agentName = uniqueAgent('node_exec_bad_cwd');
  const missing = path.join(os.tmpdir(), `foxwarm-missing-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await assert.rejects(
      () => exec(
        { command: 'pwd', cwd: missing, timeout: 5 },
        { sessionId: 'shared-node-test-bad-cwd', session: { agent: agentName, currentNode: 'test-node' }, runtimeNodeId: 'test-node' },
      ),
      (err: any) => {
        assert.match(String(err?.message || err), /working directory is invalid/i);
        assert.match(String(err?.message || err), /Raw cwd/i);
        assert.match(String(err?.message || err), /Resolved cwd/i);
        assert.match(String(err?.message || err), /not a missing `\/bin\/bash`/i);
        return true;
      },
    );
  } finally {
    await cleanupAgent(agentName);
  }
});

test('node exec background timeout and completion point to a log path, not an opaque execId only', async () => {
  const agentName = uniqueAgent('node_exec_bg');
  const outputToken = `remote-done-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events: string[] = [];
  process.env.FOXWARM_TEST_REMOTE_DONE = outputToken;
  try {
    const result = await exec(
      { command: 'sleep 2; echo "$FOXWARM_TEST_REMOTE_DONE"', timeout: 1 },
      {
        sessionId: 'shared-node-test-bg',
        session: { agent: agentName, currentNode: 'test-node' },
        runtimeNodeId: 'test-node',
        queueSystemEvent: async (message: string) => { events.push(message); },
      },
    );

    assert.match(String(result), /Process running longer than 1s/i);
    assert.match(String(result), /Node: `test-node`/);
    assert.match(String(result), /PID: \d+/);
    assert.match(String(result), /Log file: /);
    assert.doesNotMatch(String(result), /execId:/);

    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && events.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    assert.equal(events.length, 1);
    assert.match(events[0], /Background Process Finished/);
    assert.match(events[0], /Node: `test-node`/);
    assert.match(events[0], /Full output in /);
    assert.doesNotMatch(events[0], new RegExp(outputToken));
  } finally {
    delete process.env.FOXWARM_TEST_REMOTE_DONE;
    await cleanupAgent(agentName);
  }
});

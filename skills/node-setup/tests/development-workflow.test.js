const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Monty } = require('@pydantic/monty');

function plain(value) {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  return value;
}

async function run(args, tools) {
  const source = await fs.readFile(path.join(__dirname, '../examples/development_workflow.py'), 'utf8');
  const pool = await Monty.create({ minProcesses: 1, maxProcesses: 1 });
  const session = await pool.checkout({ limits: { maxMemory: 64 * 1024 * 1024, maxDurationSecs: 5 } });
  try {
    return plain(await session.feedRun(`${source}\nmain(args)`, {
      inputs: { args },
      externalLookup: { call_tool: descriptor => tools(plain(descriptor)) },
    }));
  } finally {
    await session.close();
    await pool.close();
  }
}

test('ToolScript runs real evidence-only Git snapshot under Monty without neighboring imports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-workflow-monty-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('config', 'user.name', 'Fixture Developer');
    git('config', 'user.email', 'developer@example.invalid');
    await fs.writeFile(path.join(root, 'file'), 'base\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Fixture base');
    const base = git('rev-parse', 'HEAD');
    const calls = [];
    const result = await run({ phase: 'snapshot', nodeId: 'fixture/build', workDir: root, tempDir: root, base }, request => {
      calls.push(request);
      assert.equal(request.source, 'node');
      assert.equal(request.nodeId, 'fixture/build');
      assert.equal(request.name, 'exec');
      const content = execFileSync('/bin/sh', ['-c', request.args.command], { cwd: request.args.cwd, encoding: 'utf8' });
      return { status: 'completed', exitCode: 0, content, truncated: false };
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.data.commits, []);
    assert.equal(result.data.bundlePath, null);
    assert.equal(result.data.head, base);
    assert.equal(calls.length, 1);

    const pendingCalls = [];
    const pending = await run({ phase: 'snapshot', nodeId: 'fixture/build', workDir: root, tempDir: root, base }, request => {
      pendingCalls.push(request);
      return { status: 'running', execId: 'fixture-pending', logPath: '/tmp/fixture.log' };
    });
    assert.equal(pending.status, 'pending');
    assert.equal(pending.exec.execId, 'fixture-pending');
    assert.equal(pendingCalls.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Monty assignment preserves caller handoff fields and verifies actual Task notification', async () => {
  const calls = [];
  const task = { id: 'task_fixture', title: 'Inspect parser', assignmentNotificationStatus: 'sent' };
  const result = await run({
    phase: 'assign',
    prepared: { phase: 'prepare', status: 'completed', nodeId: 'fixture/build', workDir: '/workspace/task', base: 'a'.repeat(40), materials: [] },
    task: { title: task.title, description: 'Bounded read-only task' },
    child: { suffix: 'parser', handoffRecall: 'Caller-written recall', handoffConfirmation: 'Caller-written review' },
  }, request => {
    calls.push(request);
    if (request.name === 'create_child_session') return { output: 'Native child receipt', sentNotifications: 1 };
    if (request.args.action === 'create') return { output: JSON.stringify({ taskId: task.id, sentNotifications: 0 }) };
    return { output: JSON.stringify({ task }) };
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.taskId, task.id);
  const child = calls.find(request => request.name === 'create_child_session').args;
  assert.equal(child.displayName, task.title);
  assert.equal(child.node, 'fixture/build');
  assert.equal(child.handoffRecall, 'Caller-written recall');
  assert.equal(child.handoffConfirmation, 'Caller-written review');
  assert.equal(Object.keys(child).at(-1), 'handoffConfirmation');
  assert.equal('forceModel' in child, false);
  assert.deepEqual(calls.map(request => request.name), ['task', 'create_child_session', 'task']);
});

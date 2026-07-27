import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'fs-extra';
import { MAX_FULL_LOG_READ_BYTES, PersistentExecManager, type RunningExecEntry } from './persistentExec';

function buildExecEntry(logPath: string, overrides: Partial<RunningExecEntry> = {}): RunningExecEntry {
  return {
    id: 'test-exec',
    pid: 4321,
    sessionId: 'main/test',
    agentName: 'main',
    nodeId: 'master',
    command: 'test command',
    initialCwd: path.dirname(logPath),
    logPath,
    statusPath: `${logPath}.exit.json`,
    cwdPath: `${logPath}.cwd.txt`,
    startedAt: Date.now(),
    notifyOnCompletion: false,
    ...overrides,
  };
}

async function createManager(root: string): Promise<PersistentExecManager> {
  return new PersistentExecManager({
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
  });
}

test('persistent exec co-locates retained scripts and coordination metadata with dated log artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-artifacts-'));
  const manager = await createManager(root);
  const execRoot = path.join(root, 'exec');
  const command = process.platform === 'win32' ? 'Write-Output "artifact placement"' : 'printf "artifact placement\\n"';

  try {
    const entry = await manager.startPersistentExec({ command, agentName: 'main', nodeId: 'master' });
    const status = await manager.waitForExecCompletion(entry.id, 10_000);
    assert.ok(status, 'short persistent exec should finish');

    const datedDir = path.dirname(entry.logPath);
    const commandSuffix = process.platform === 'win32' ? '.command.ps1' : '.command.sh';
    assert.match(path.basename(datedDir), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(datedDir, path.dirname(entry.statusPath));
    assert.equal(datedDir, path.dirname(entry.cwdPath));
    assert.equal(await fs.pathExists(path.join(datedDir, `${entry.id}${commandSuffix}`)), true);
    if (process.platform === 'win32') {
      assert.equal(await fs.pathExists(path.join(datedDir, `${entry.id}.user.ps1`)), true);
    }

    assert.equal(await fs.pathExists(path.join(execRoot, `${entry.id}${commandSuffix}`)), false);
    assert.equal(await fs.pathExists(path.join(execRoot, `${entry.id}.paths.json`)), false);
    assert.equal(await fs.pathExists(path.join(datedDir, `${entry.id}.paths.json`)), false);
    await manager.finalizeForegroundExec(entry.id);
  } finally {
    await fs.remove(root);
  }
});

test('PersistentExecManager serializes concurrent registry mutations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-'));
  const registryPath = path.join(root, 'running-exec.json');
  const manager = new PersistentExecManager({
    registryPath,
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
  });

  try {
    await Promise.all([manager.initialize(), manager.initialize(), manager.initialize()]);
    const [first, second] = await Promise.all([
      manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' }),
      manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' }),
    ]);

    let persisted = await fs.readJson(registryPath);
    assert.deepEqual(new Set(persisted.execs.map((entry: any) => entry.id)), new Set([first.id, second.id]));

    await Promise.all([
      manager.markExecForBackgroundNotification(first.id),
      manager.markExecForBackgroundNotification(second.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.equal(persisted.execs.length, 2);
    assert(persisted.execs.every((entry: any) => entry.notifyOnCompletion === true));

    await Promise.all([
      manager.finalizeForegroundExec(first.id),
      manager.finalizeForegroundExec(second.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.deepEqual(persisted.execs, []);
    assert.deepEqual(manager.listRunningExecs(), []);

    const third = await manager.startPersistentExec({ command: 'sleep 0.2', agentName: 'main', nodeId: 'master' });
    await Promise.all([
      manager.markExecForBackgroundNotification(third.id),
      manager.finalizeForegroundExec(third.id),
    ]);
    persisted = await fs.readJson(registryPath);
    assert.deepEqual(persisted.execs, []);
    assert.deepEqual(manager.listRunningExecs(), []);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec keeps ordinary and truncated-small text behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-output-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');

  try {
    await fs.writeFile(logPath, 'ordinary output\n');
    const ordinary = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    assert.equal(ordinary, 'ordinary output\n---\nExit code: 0');

    await fs.writeFile(logPath, 'x'.repeat(24000));
    const truncated = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    assert.match(truncated, /\[foxwarm: line too long/);
    assert.match(truncated, /Original output: 1 line\(s\), 24000 character\(s\)\./);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec uses bounded head and tail samples for oversized text logs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-large-text-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const head = Buffer.concat([Buffer.from('TEXT_HEAD 中文😀'), Buffer.from([0x00, 0x01, 0xc2, 0x81, 0xff]), Buffer.from('\n')]);
  const tail = Buffer.from('\nTEXT_TAIL');
  const text = Buffer.concat([head, Buffer.from('m'.repeat(MAX_FULL_LOG_READ_BYTES + 128)), tail]);

  try {
    await fs.writeFile(logPath, text);
    const originalReadFile = fs.readFile;
    (fs as any).readFile = async () => {
      throw new Error('oversized logs must not use readFile');
    };
    let result: string;
    try {
      result = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    } finally {
      (fs as any).readFile = originalReadFile;
    }

    assert.ok(result!.includes('TEXT_HEAD 中文😀\x00\x01\u0081\\xff'));
    assert.match(result!, /TEXT_TAIL/);
    assert.match(result!, /\[foxwarm: oversized log middle omitted; showing bounded head and tail samples/);
    assert.match(result!, /escaped 1 byte\(s\)/);
    assert.match(result!, /Command output saved to:/);
    assert.match(result!, new RegExp(`Original log size: ${text.length} bytes\\.`));
    assert.match(result!, /Foxwarm \\xNN placeholders above are display conversions, not literal command output\./);
    assert.doesNotMatch(result!, /Original output: .*line\(s\)/);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec tolerates an incomplete UTF-8 sequence at a bounded sample edge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-utf8-edge-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const head = Buffer.concat([Buffer.from('a'.repeat(4998)), Buffer.from([0xe4, 0xb8])]);
  const text = Buffer.concat([head, Buffer.from([0xad]), Buffer.from('m'.repeat(MAX_FULL_LOG_READ_BYTES + 128)), Buffer.from('\n尾😀')]);

  try {
    await fs.writeFile(logPath, text);
    const result = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    assert.match(result, /\\xe4\\xb8/);
    assert.match(result, /尾😀/);
    assert.doesNotMatch(result, /oversized binary log/);
    assert.doesNotMatch(result, /�/);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec treats invalid UTF-8 at actual file boundaries as suspicious', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-invalid-file-edge-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const text = Buffer.concat([Buffer.from([0x80]), Buffer.from('m'.repeat(MAX_FULL_LOG_READ_BYTES + 128)), Buffer.from('TAIL'), Buffer.from([0xe4, 0xb8])]);

  try {
    await fs.writeFile(logPath, text);
    const result = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    assert.match(result, /^\\x80/);
    assert.match(result, /TAIL\\xe4\\xb8/);
    assert.match(result, /escaped 3 byte\(s\)/);
    assert.match(result, /Foxwarm \\xNN placeholders above are display conversions, not literal command output\./);
    assert.doesNotMatch(result, /oversized binary log/);

    const timeout = await manager.buildBackgroundTimeoutResult(buildExecEntry(logPath), 7);
    assert.match(timeout, /Foxwarm \\xNN placeholders above are display conversions, not literal command output\./);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec keeps a representative colorized log text-like without display conversion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-terminal-markup-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const head = Buffer.from('COLOR \x1b[31mred\x1b[0m visible\n');
  const text = Buffer.concat([head, Buffer.from('m'.repeat(MAX_FULL_LOG_READ_BYTES + 128)), Buffer.from('\nTAIL')]);

  try {
    await fs.writeFile(logPath, text);
    const result = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 0, finishedAt: new Date().toISOString() });
    assert.ok(result.includes('COLOR \x1b[31mred\x1b[0m visible'));
    assert.doesNotMatch(result, /escaped \d+ byte\(s\)/);
    assert.doesNotMatch(result, /Foxwarm \\xNN placeholders above are display conversions/);
    assert.doesNotMatch(result, /oversized binary log/);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec renders control-heavy binary logs as bounded hexadecimal and keeps timeout previews safe', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-large-binary-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const bytes = Buffer.alloc(MAX_FULL_LOG_READ_BYTES + 256);
  Buffer.from('BINARY_HEAD').copy(bytes, 0);
  Buffer.from('BINARY_TAIL').copy(bytes, bytes.length - 'BINARY_TAIL'.length);

  try {
    await fs.writeFile(logPath, bytes);
    const foreground = await manager.buildForegroundExecResult(buildExecEntry(logPath), { exitCode: 1, finishedAt: new Date().toISOString() });
    assert.match(foreground, /oversized binary log/);
    assert.match(foreground, /Head \(64 bytes\): 42494e4152595f48454144/);
    assert.doesNotMatch(foreground, /BINARY_HEAD/);
    assert.match(foreground, new RegExp(`Original log size: ${bytes.length} bytes\\.`));
    assert.doesNotMatch(foreground, /Original output: .*line\(s\)/);
    assert.doesNotMatch(foreground, /Foxwarm \\xNN placeholders above are display conversions/);

    const timeout = await manager.buildBackgroundTimeoutResult(buildExecEntry(logPath), 7);
    assert.match(timeout, /Partial Output:[\s\S]*oversized binary log/);
    assert.match(timeout, /42494e4152595f48454144/);
    assert.doesNotMatch(timeout, /BINARY_HEAD/);
    assert.match(timeout, new RegExp(`Original log size: ${bytes.length} bytes\\.`));
    assert.doesNotMatch(timeout, /Foxwarm \\xNN placeholders above are display conversions/);
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec completion preserves both ends of a shortened command and describes captured output accurately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-completion-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const command = `echo \`COMMAND_HEAD\` ${'middle '.repeat(30)}\`COMMAND_TAIL\``;

  try {
    const message = manager.buildCompletionMessage(
      buildExecEntry(logPath, { command }),
      { exitCode: 0, finishedAt: new Date().toISOString() },
    );
    assert.match(message, /COMMAND_HEAD/);
    assert.match(message, /COMMAND_TAIL/);
    assert.match(message, /\[foxwarm: command middle omitted\]/);
    assert.match(message, /\\`COMMAND_HEAD\\`/);
    assert.match(message, new RegExp(`Command output in ${logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(message, /Full output/);
  } finally {
    await fs.remove(root);
  }
});

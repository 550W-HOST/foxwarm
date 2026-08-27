import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'fs-extra';
import {
  BACKGROUND_PROCESS_CMDLINE_LIMIT,
  BACKGROUND_PROCESS_TREE_LIMIT,
  MAX_FULL_LOG_READ_BYTES,
  PersistentExecManager,
  PERSISTENT_EXEC_ID_NAMESPACE_SIZE,
  PERSISTENT_EXEC_ID_PATTERN,
  generatePersistentExecPetname,
  formatProcessTreeSnapshot,
  truncateProcessCmdline,
  type PersistentExecManagerOptions,
  type RunningExecEntry,
} from './persistentExec';
import { nativeProcessOperations, type ProcessOperations } from './processOperations';

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

test('persistent exec petnames are deterministic through the random seam and path-safe', () => {
  const values = [0, 19];
  const bounds: number[] = [];
  const id = generatePersistentExecPetname(max => { bounds.push(max); return values.shift()!; });
  assert.equal(id, 'amber-otter');
  assert.deepEqual(bounds, [128, 264]);
  assert.equal(PERSISTENT_EXEC_ID_NAMESPACE_SIZE, 33_792);
  assert.match(id, PERSISTENT_EXEC_ID_PATTERN);
  assert.doesNotMatch(id, /[\\/._\s]/);
  assert.throws(() => generatePersistentExecPetname(() => -1), /out-of-range/);
});

test('persistent exec allocation retries registry collisions and fails closed on bounded exhaustion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-petname-collision-'));
  const registryPath = path.join(root, 'running-exec.json');
  const staleLog = path.join(root, 'stale.log');
  await fs.writeJson(registryPath, { execs: [{
    id: 'amber-badger', pid: 999999, sessionId: 'source', agentName: 'main', nodeId: 'master', command: 'old',
    initialCwd: root, logPath: staleLog, statusPath: `${staleLog}.exit.json`, cwdPath: `${staleLog}.cwd.txt`,
    startedAt: Date.now(), notifyOnCompletion: true,
  }] });
  const sequence = [0, 0, 0, 1];
  const manager = new PersistentExecManager({
    getDefaultCwd: () => root, getExecTempDir: () => root, registryPath,
    randomInt: () => sequence.shift()!, isEntryRunning: entry => entry.id === 'amber-badger',
  });
  const exhausted = new PersistentExecManager({
    getDefaultCwd: () => root, getExecTempDir: () => root, registryPath,
    randomInt: () => 0, isEntryRunning: () => true,
  });
  try {
    await manager.initialize();
    const entry = await manager.startPersistentExec({ command: 'printf ok', sessionId: 'source', agentName: 'main' });
    assert.equal(entry.id, 'amber-beacon');
    const status = await manager.waitForExecCompletion(entry.id, 5000);
    assert.ok(status);
    await manager.finalizeForegroundExec(entry.id);
    await assert.rejects(
      () => manager.startPersistentExec({ execId: entry.id, command: 'printf reused', sessionId: 'source', agentName: 'main' }),
      /recent completion identity/,
    );

    await exhausted.initialize();
    await assert.rejects(
      () => exhausted.startPersistentExec({ command: 'printf never', sessionId: 'source', agentName: 'main' }),
      /did not yield a unique ID after 128 attempts/,
    );
  } finally {
    await manager.shutdown();
    await exhausted.shutdown();
    await fs.remove(root);
  }
});

async function createManager(root: string): Promise<PersistentExecManager> {
  return new PersistentExecManager({
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
  });
}

test('background process tree preserves topology and bounds cmdlines and process count', () => {
  const longCmdline = `worker ${'x'.repeat(140)}`;
  const entries = [
    { pid: 100, parentPid: 1, cmdline: '/bin/bash /tmp/managed.command.sh' },
    { pid: 120, parentPid: 100, cmdline: 'second child' },
    { pid: 110, parentPid: 100, cmdline: longCmdline },
    { pid: 111, parentPid: 110, cmdline: 'grandchild --flag' },
    { pid: 999, parentPid: 1, cmdline: 'unrelated process' },
  ];

  const tree = formatProcessTreeSnapshot(entries, 100);
  assert.equal(tree, [
    'Process tree (best-effort live snapshot; managed shell-script root PID 100):',
    'PID 100: /bin/bash /tmp/managed.command.sh',
    `  PID 110: ${truncateProcessCmdline(longCmdline)}`,
    '    PID 111: grandchild --flag',
    '  PID 120: second child',
  ].join('\n'));
  const renderedLongCmdline = tree.match(/^  PID 110: (.*)$/m)?.[1];
  assert.equal(Array.from(renderedLongCmdline || '').length, BACKGROUND_PROCESS_CMDLINE_LIMIT);
  assert.match(renderedLongCmdline || '', /…$/);
  assert.doesNotMatch(tree, /unrelated process/);
  assert.match(
    formatProcessTreeSnapshot(entries, 404),
    /Process tree unavailable: the root process was no longer visible during inspection\./,
  );

  const manyChildren = [
    entries[0],
    ...Array.from({ length: BACKGROUND_PROCESS_TREE_LIMIT + 5 }, (_, index) => ({
      pid: 200 + index,
      parentPid: 100,
      cmdline: `child-${index}`,
    })),
  ];
  const boundedTree = formatProcessTreeSnapshot(manyChildren, 100);
  assert.equal((boundedTree.match(/^\s*PID /gm) || []).length, BACKGROUND_PROCESS_TREE_LIMIT);
  assert.match(boundedTree, /\[foxwarm: 6 additional descendant process\(es\) omitted\]$/);
});

test('background timeout uses a metadata footer with a live process tree and degrades inspection failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-tree-'));
  const logPath = path.join(root, 'command.log');
  await fs.writeFile(logPath, 'partial output\n');
  const entry = buildExecEntry(logPath, { pid: 100 });
  const manager = new PersistentExecManager({
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
    processSnapshotProvider: async () => [
      { pid: 100, parentPid: 1, cmdline: '/bin/bash /tmp/managed.command.sh' },
      { pid: 101, parentPid: 100, cmdline: 'sleep 30' },
    ],
  });
  const failingManager = new PersistentExecManager({
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
    processSnapshotProvider: async () => { throw new Error('inspection denied'); },
  });

  try {
    const result = await manager.buildBackgroundTimeoutResult(entry, 7);
    assert.match(result, /^Partial Output:\npartial output\n---\n\[Process running longer than 7s\] Switched to background\./);
    assert.match(result, /continue other work, remember this process remains outstanding until its completion message arrives/i);
    assert.match(result, /managed shell-script root PID 100[\s\S]*PID 100: \/bin\/bash \/tmp\/managed\.command\.sh[\s\S]*  PID 101: sleep 30/);
    assert.ok(result.endsWith(`Log file: ${logPath}`));

    const degraded = await failingManager.buildBackgroundTimeoutResult(entry, 7);
    assert.match(degraded, /Process tree unavailable: process inspection failed or is unsupported on this platform\./);
    assert.ok(degraded.endsWith(`Log file: ${logPath}`));
  } finally {
    await fs.remove(root);
  }
});

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

test('persistent exec launches and inspects through the injected process operations seam', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-process-ops-'));
  const calls = { launch: 0, inspect: 0, cwd: 0 };
  const operations: ProcessOperations = {
    ...nativeProcessOperations,
    async launch(request) {
      calls.launch += 1;
      return nativeProcessOperations.launch(request);
    },
    inspectSnapshot() {
      calls.inspect += 1;
      return nativeProcessOperations.inspectSnapshot();
    },
    readWorkingDirectory(pid) {
      calls.cwd += 1;
      return nativeProcessOperations.readWorkingDirectory(pid);
    },
    isRunning(pid) {
      return nativeProcessOperations.isRunning(pid);
    },
  };
  const manager = new PersistentExecManager({
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
    processOperations: operations,
  });

  try {
    const entry = await manager.startPersistentExec({ command: 'sleep 1', agentName: 'main', nodeId: 'master' });
    assert.equal(calls.launch, 1);
    assert.equal(await manager.readLiveExecWorkingDirectory(entry), root);
    const timeout = await manager.buildBackgroundTimeoutResult(entry, 1);
    assert.match(timeout, new RegExp(`managed shell-script root PID ${entry.pid}`));
    assert.equal(calls.cwd, 1);
    assert.equal(calls.inspect, 1);

    const status = await manager.waitForExecCompletion(entry.id, 10_000);
    assert.ok(status);
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

test('persistent exec persists script identity, uses entry-aware restart liveness, and shuts down reconciliation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-entry-truth-')); const artifact = path.join(root, 'exec'); await fs.ensureDir(artifact);
  const scriptPath = path.join(artifact, 'exec_entry_truth.command.sh'); const logPath = path.join(artifact, 'managed.log'); const statusPath = `${logPath}.status.json`; const cwdPath = `${logPath}.cwd.txt`; await fs.writeFile(scriptPath, '#!/bin/bash\n'); await fs.writeFile(logPath, 'partial\n');
  await fs.writeJson(path.join(artifact, 'running.json'), { execs: [{ id: 'exec_entry_truth', pid: process.pid, sessionId: 's', agentName: 'main', nodeId: 'n', command: 'sleep', initialCwd: root, logPath, statusPath, cwdPath, startedAt: Date.now() - 10_000, notifyOnCompletion: true }] });
  let entryChecks = 0; let processChecks = 0; let idleCallbacks = 0; const delivered: string[] = [];
  const manager = new PersistentExecManager({ registryPath: path.join(artifact, 'running.json'), nodeId: 'n', getDefaultCwd: () => root, getExecTempDir: () => artifact,
    processOperations: { ...nativeProcessOperations, isRunning: () => { processChecks += 1; return true; } },
    isEntryRunning: entry => { entryChecks += 1; assert.equal(entry.scriptPath, scriptPath); return false; },
    onRegistryIdle: () => { idleCallbacks += 1; },
    completionDispatcher: async (_entry, _status, message) => { delivered.push(message); } });
  try {
    await manager.initialize(); assert.equal(entryChecks, 1); assert.equal(processChecks, 0); assert.match(delivered[0], /no status file was written/i); assert.deepEqual(manager.listRunningExecs(), []); assert.equal(idleCallbacks, 1); assert.deepEqual((await fs.readJson(path.join(artifact, 'running.json'))).execs, []);
    await manager.shutdown(); assert.equal((manager as any).reconcileTimer, null); await manager.shutdown();
  } finally { await fs.remove(root); }
});

test('persistent exec reconciles a dead stale entry after its dated artifact directory was removed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-stale-status-'));
  const registryPath = path.join(root, 'running-exec.json');
  const statusPath = path.join(root, 'exec', '2026-07-27', 'stale.log.exit.json');
  const entry = buildExecEntry(statusPath.slice(0, -'.exit.json'.length), {
    id: 'stale-background-exec',
    pid: 99_999_999,
    startedAt: Date.now() - 10_000,
    notifyOnCompletion: true,
  });
  const deliveries: Array<{ entry: RunningExecEntry; status: unknown }> = [];
  const errors: unknown[] = [];
  let livenessChecks = 0;
  const manager = new PersistentExecManager({
    registryPath,
    nodeId: 'master',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
    completionDispatcher: async (deliveredEntry, status) => {
      deliveries.push({ entry: deliveredEntry, status });
    },
    processOperations: {
      ...nativeProcessOperations,
      isRunning() {
        livenessChecks += 1;
        return false;
      },
    },
    logger: { error: payload => errors.push(payload) },
  });

  try {
    await fs.writeJson(registryPath, { execs: [entry] });
    assert.equal(await fs.pathExists(path.dirname(statusPath)), false);

    await manager.initialize();

    assert.equal(deliveries.length, 1);
    assert.equal(livenessChecks, 1);
    assert.equal(deliveries[0].entry.id, entry.id);
    assert.equal((deliveries[0].status as { error?: string }).error, 'Process exited but no status file was written.');
    assert.equal(errors.length, 0);
    assert.deepEqual(manager.listRunningExecs(), []);
    assert.deepEqual((await fs.readJson(registryPath)).execs, []);
    assert.equal((await fs.readJson(statusPath)).error, 'Process exited but no status file was written.');
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec retains a finished background entry across restart until completion delivery is acknowledged', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-delivery-ack-'));
  const registryPath = path.join(root, 'running-exec.json');
  const logPath = path.join(root, 'exec', 'finished.log');
  const entry = buildExecEntry(logPath, {
    id: 'exec_finished_delivery_ack',
    pid: 99_999_998,
    notifyOnCompletion: true,
    completionCapability: 'persisted-capability',
  });
  let acceptDelivery = false;
  let attempts = 0;
  const managerOptions: PersistentExecManagerOptions = {
    registryPath,
    nodeId: 'remote-a',
    getDefaultCwd: () => root,
    getExecTempDir: () => path.join(root, 'exec'),
    completionDispatcher: async deliveredEntry => {
      attempts += 1;
      assert.equal(deliveredEntry.completionCapability, 'persisted-capability');
      if (!acceptDelivery) throw new Error('master did not acknowledge completion');
    },
  };
  const manager = new PersistentExecManager(managerOptions);
  try {
    await fs.ensureDir(path.dirname(logPath));
    await fs.writeFile(logPath, 'done\n');
    await fs.writeJson(entry.statusPath, { exitCode: 7, finishedAt: new Date().toISOString() });
    await fs.writeJson(registryPath, { execs: [entry] });

    await manager.initialize();
    assert.equal(attempts, 1);
    assert.equal(manager.listRunningExecs().length, 1);
    assert.equal((await fs.readJson(registryPath)).execs.length, 1);

    acceptDelivery = true;
    const restartedManager = new PersistentExecManager(managerOptions);
    await restartedManager.initialize();
    assert.equal(attempts, 2);
    assert.equal(restartedManager.listRunningExecs().length, 0);
    assert.equal((await fs.readJson(registryPath)).execs.length, 0);
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

test('persistent exec preserves foreground output boundary whitespace and reports a missing trailing LF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-whitespace-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const status = { exitCode: 0, finishedAt: new Date().toISOString() };

  try {
    const indented = '    alpha\n  beta\n\tcharlie\n';
    await fs.writeFile(logPath, indented);
    assert.equal(
      await manager.buildForegroundExecResult(buildExecEntry(logPath), status),
      `${indented}---\nExit code: 0`,
    );

    const whitespaceOnly = '  \t \n\n';
    await fs.writeFile(logPath, whitespaceOnly);
    assert.equal(
      await manager.buildForegroundExecResult(buildExecEntry(logPath), status),
      `${whitespaceOnly}---\nExit code: 0`,
    );

    const trailingSpacesAndBlankLines = 'alpha\n   \n\n';
    await fs.writeFile(logPath, trailingSpacesAndBlankLines);
    assert.equal(
      await manager.buildForegroundExecResult(buildExecEntry(logPath), status),
      `${trailingSpacesAndBlankLines}---\nExit code: 0`,
    );

    const noTrailingLf = 'alpha  ';
    await fs.writeFile(logPath, noTrailingLf);
    assert.equal(
      await manager.buildForegroundExecResult(buildExecEntry(logPath), status),
      `${noTrailingLf}\n---\nExit code: 0\nOriginal command output had no trailing newline.`,
    );

    await fs.writeFile(logPath, '');
    assert.equal(
      await manager.buildForegroundExecResult(buildExecEntry(logPath), status),
      '(No output)\n---\nExit code: 0',
    );
  } finally {
    await fs.remove(root);
  }
});

test('persistent exec preserves timeout partial-output boundary whitespace and reports the current missing trailing LF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-persistent-exec-partial-whitespace-'));
  const manager = await createManager(root);
  const logPath = path.join(root, 'command.log');
  const entry = buildExecEntry(logPath);

  try {
    const withTrailingLf = '    alpha\n  beta\n   \n\n';
    await fs.writeFile(logPath, withTrailingLf);
    const lfResult = await manager.buildBackgroundTimeoutResult(entry, 7);
    assert.ok(lfResult.startsWith(`Partial Output:\n${withTrailingLf}---\n`));
    assert.doesNotMatch(lfResult, /Partial output captured so far had no trailing newline\./);

    const noTrailingLf = '  \t  ';
    await fs.writeFile(logPath, noTrailingLf);
    const noLfResult = await manager.buildBackgroundTimeoutResult(entry, 7);
    assert.ok(noLfResult.startsWith(`Partial Output:\n${noTrailingLf}\n---\n`));
    assert.match(noLfResult, /Partial output captured so far had no trailing newline\.\nexecId: test-exec\nPID: 4321/);
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

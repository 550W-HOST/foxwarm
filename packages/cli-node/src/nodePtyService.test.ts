import assert from 'assert';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import test from 'node:test';
import { NodePtyService, type NodePtyServiceEvent } from './nodePtyService';

const execFileAsync = promisify(execFile);

class FakePtyProcess {
  pid = 4321;
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
    return { dispose() {} };
  }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; }
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
  emitExit(exitCode: number) { for (const listener of this.exitListeners) listener({ exitCode }); }
}

test('node PTY service manages create, attach, stream, input, resize, and close', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-pty-'));
  const process = new FakePtyProcess();
  const spawnCalls: any[] = [];
  const events: NodePtyServiceEvent[] = [];
  const service = new NodePtyService({
    spawn(file, args, options) {
      spawnCalls.push({ file, args, options });
      return process;
    },
  }, tempDir, (event) => events.push(event));

  try {
    const created = await service.execute('create', { cwd: tempDir, cols: 90, rows: 25 });
    const terminalId = created.terminal.id;
    assert.equal(created.terminal.cwd, tempDir);
    assert.equal(created.terminal.pid, 4321);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].options.cols, 90);
    assert.equal(spawnCalls[0].options.rows, 25);

    process.emitData('before attach');
    assert.equal(events.length, 0);
    const attached = await service.execute('attach', { terminalId });
    assert.equal(attached.backlog, 'before attach');

    process.emitData(' after attach');
    assert.deepEqual(events, [{ type: 'output', terminalId, data: ' after attach' }]);

    await service.execute('input', { terminalId, data: 'echo hi\r' });
    assert.deepEqual(process.writes, ['echo hi\r']);
    await service.execute('resize', { terminalId, cols: 120, rows: 40 });
    assert.deepEqual(process.sizes, [[120, 40]]);

    await service.execute('detach', { terminalId });
    process.emitData(' detached');
    assert.equal(events.length, 1);

    const listed = await service.execute('list', {});
    assert.equal(listed.terminals.length, 1);
    await service.execute('close', { terminalId });
    assert.equal(process.killed, true);
    assert.equal((await service.execute('list', {})).terminals.length, 0);
  } finally {
    await service.dispose();
    await fs.remove(tempDir);
  }
});

test('node PTY service emits exit for a running attached terminal', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-pty-exit-'));
  const process = new FakePtyProcess();
  const events: NodePtyServiceEvent[] = [];
  const service = new NodePtyService({ spawn: () => process }, tempDir, (event) => events.push(event));
  try {
    const created = await service.execute('create', { cwd: tempDir });
    await service.execute('attach', { terminalId: created.terminal.id });
    process.emitExit(7);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(events[0]?.type, 'exit');
    assert.equal((events[0] as any).exitCode, 7);
    assert.equal((await service.execute('list', {})).terminals.length, 0);
  } finally {
    await service.dispose();
    await fs.remove(tempDir);
  }
});

test('node PTY service bridges its terminal-scoped code helper through service events', async () => {
  if (globalThis.process.platform === 'win32') return;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-pty-code-'));
  await fs.writeFile(path.join(tempDir, 'target.ts'), 'export {};\n');
  const fakeProcess = new FakePtyProcess();
  let spawnOptions: any;
  const events: NodePtyServiceEvent[] = [];
  const service = new NodePtyService({
    spawn(_file, _args, options) { spawnOptions = options; return fakeProcess; },
  }, tempDir, (event) => events.push(event));
  try {
    await service.execute('create', { cwd: tempDir });
    const helperResult = execFileAsync('code', ['--goto', 'target.ts:1:2'], { cwd: tempDir, env: spawnOptions.env });
    for (let attempt = 0; attempt < 100 && !events.some((event) => event.type === 'code-request'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const event = events.find((candidate) => candidate.type === 'code-request') as Extract<NodePtyServiceEvent, { type: 'code-request' }>;
    assert.ok(event);
    assert.deepEqual(event.request, { kind: 'openFile', path: path.join(tempDir, 'target.ts'), startLine: 1, startColumn: 2 });
    await service.execute('code-result', { requestId: event.requestId, ok: true, message: 'Opened target.ts' });
    assert.equal((await helperResult).stdout.trim(), 'Opened target.ts');
  } finally {
    await service.dispose();
    await fs.remove(tempDir);
  }
});

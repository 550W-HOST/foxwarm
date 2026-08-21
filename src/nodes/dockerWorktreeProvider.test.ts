import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import '../llm';
import { DockerCommandError, DockerWorktreeNodeProvider, NativeDockerCommandRunner, type DockerCommandRunner } from './dockerWorktreeProvider';
import { NodeProviderRegistry } from './providerRegistry';

const execFileAsync = promisify(execFile);

const localDockerExecLauncher: typeof spawn = ((_command: any, args: any, options: any) => {
  const values = args as string[]; const execIndex = values.indexOf('exec'); const env: NodeJS.ProcessEnv = {};
  let index = execIndex + 1;
  while (values[index] === '-e') { const item = values[index + 1]; const split = item.indexOf('='); env[item.slice(0, split)] = item.slice(split + 1); index += 2; }
  assert.equal(values[index], '-w'); const cwd = values[index + 1]; index += 3;
  assert.equal(values[index], '/bin/bash'); const script = values[index + 1];
  if (env.FOXWARM_EXEC_NODE_PATH === '/usr/local/bin/node') env.FOXWARM_EXEC_NODE_PATH = process.execPath;
  return spawn('/bin/bash', [script], { ...options, cwd, env, shell: false });
}) as typeof spawn;

class FakeDocker implements DockerCommandRunner {
  readonly calls: Array<{ args: string[]; input?: string }> = [];
  readonly containers = new Map<string, any>();
  failRunAfterCreate = false;
  mismatchRunAfterCreate = false;
  pauseRunUntilAbort = false;
  pauseExecUntilAbort = false;
  failRmCount = 0;
  onRm?: () => void;
  topRows: string[] = [];
  failTopCount = 0;
  immediateExitOnRun = false;
  closedAfterAbort = false;
  get container(): any { return [...this.containers.values()][0]; }
  async run(args: string[], options: { input?: string; signal?: AbortSignal } = {}) {
    this.calls.push({ args: [...args], input: options.input });
    if (options.signal?.aborted) throw new DockerCommandError('cancelled');
    if (args[0] === 'run') {
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) if (args[index] === '--label') { const split = args[++index].indexOf('='); labels[args[index].slice(0, split)] = args[index].slice(split + 1); }
      const mounts: any[] = []; for (let index = 0; index < args.length; index++) if (args[index] === '--mount') { const fields = Object.fromEntries(args[++index].split(',').map(item => { const split = item.indexOf('='); return split < 0 ? [item, true] : [item.slice(0, split), item.slice(split + 1)]; })); mounts.push({ Source: fields.src, Destination: fields.dst, RW: fields.readonly !== true }); }
      const image = args[args.length - 4]; const network = args[args.indexOf('--network') + 1]; const user = args[args.indexOf('--user') + 1];
      const name = args[args.indexOf('--name') + 1]; const id = crypto.createHash('sha256').update(`${name}-${this.containers.size}`).digest('hex');
      const container = { Id: id, Name: `/${name}`, Config: { Labels: labels, Image: image, User: user }, HostConfig: { NetworkMode: network }, Mounts: mounts,
        State: this.immediateExitOnRun ? { Running: false, Paused: false, Restarting: false, Dead: false, Status: 'exited' } : { Running: true, Paused: false, Restarting: false, Dead: false, Status: 'running' } };
      this.containers.set(id, container); this.containers.set(name, container);
      if (this.pauseRunUntilAbort) await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => { this.closedAfterAbort = true; reject(new DockerCommandError('cancelled')); }, { once: true }));
      if (this.mismatchRunAfterCreate) { container.Config.Labels['foxwarm.worktree'] = '/mismatched'; throw new DockerCommandError('timeout'); }
      if (this.failRunAfterCreate) throw new DockerCommandError('timeout');
      return { stdout: `${container.Id}\n`, stderr: '' };
    }
    if (args[0] === 'inspect') {
      const container = this.containers.get(args[1]); if (!container) throw new Error('missing');
      return { stdout: JSON.stringify([container]), stderr: '' };
    }
    if (args[0] === 'exec') {
      if (this.pauseExecUntilAbort) await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => { this.closedAfterAbort = true; reject(new DockerCommandError('cancelled')); }, { once: true }));
      const request = JSON.parse(options.input || '{}');
      return { stdout: JSON.stringify({ ok: true, result: request.toolName === 'read' ? 'fixture-content' : 'File written successfully' }), stderr: '' };
    }
    if (args[0] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1] || ''; const unique = [...new Set([...this.containers.values()])];
      let selected = args.includes('-a') ? unique : unique.filter(item => item.State?.Running === true);
      if (filter.startsWith('name=^/')) selected = selected.filter(item => filter === `name=^${item.Name}$`);
      else if (filter.startsWith('id=')) selected = selected.filter(item => item.Id === filter.slice(3));
      return { stdout: selected.map(item => item.Id).join('\n'), stderr: '' };
    }
    if (args[0] === 'top') { if (this.failTopCount > 0) { this.failTopCount--; throw new DockerCommandError('failure'); } return { stdout: this.topRows.join('\n'), stderr: '' }; }
    if (args[0] === 'start') { const container = this.containers.get(args[1]); if (!container) throw new DockerCommandError('failure'); container.State = { Running: true, Paused: false, Restarting: false, Dead: false, Status: 'running' }; return { stdout: `${container.Id}\n`, stderr: '' }; }
    if (args[0] === 'unpause') { const container = this.containers.get(args[1]); if (!container) throw new DockerCommandError('failure'); container.State = { Running: true, Paused: false, Restarting: false, Dead: false, Status: 'running' }; return { stdout: '', stderr: '' }; }
    if (args[0] === 'rm') { if (this.failRmCount > 0) { this.failRmCount--; throw new DockerCommandError('failure'); } this.onRm?.(); const container = this.containers.get(args[args.length - 1]); if (container) for (const [key, value] of this.containers) if (value === container) this.containers.delete(key); return { stdout: '', stderr: '' }; }
    throw new Error(`unsupported fake Docker call ${args[0]}`);
  }
}

async function makeRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo'); await fs.ensureDir(repo);
  await execFileAsync('git', ['init', '-b', 'test-branch', repo]);
  await fs.writeFile(path.join(repo, 'file.txt'), 'hello\n');
  await execFileAsync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'file.txt']);
  await execFileAsync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  return await fs.realpath(repo);
}

async function makeLinkedWorktree(root: string): Promise<{ main: string; linked: string }> {
  const main = await makeRepo(path.join(root, 'main-root')); const linked = path.join(root, 'linked');
  await execFileAsync('git', ['-C', main, 'worktree', 'add', '-b', 'linked-branch', linked]);
  return { main: await fs.realpath(main), linked: await fs.realpath(linked) };
}

test('Docker worktree provider owns exact lifecycle, safe mounts, shared file tools, and retained destroy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-provider-'));
  const repo = await makeRepo(dir); const docker = new FakeDocker();
  const provider = new DockerWorktreeNodeProvider({
    id: 'docker-fixture', type: 'docker-worktree', command: 'sudo', args: ['-n', 'docker'], image: 'fixture:latest',
    allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'provider-state'),
    memory: '2g', cpus: 2, pidsLimit: 256, tmpfsSize: '64m',
  }, docker);
  try {
    const created = await provider.createNode({ sourceSessionId: 'source', nodeId: 'sandbox-dev', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    assert.equal(created.node?.id, 'sandbox-dev');
    assert.deepEqual(created.node?.tools.map(tool => tool.name), ['read', 'write', 'edit', 'apply_patch', 'exec']);
    const run = docker.calls.find(call => call.args[0] === 'run')!.args;
    assert.ok(run.includes('--read-only')); assert.ok(run.includes('ALL')); assert.ok(run.includes('no-new-privileges'));
    assert.ok(run.includes('none')); assert.equal(run.includes('/var/run/docker.sock'), false);
    const gitDir = await fs.realpath(path.join(repo, '.git'));
    assert.ok(run.some(value => value === `type=bind,src=${repo},dst=${repo}`));
    assert.ok(run.some(value => value.includes(`src=${gitDir},dst=${gitDir},readonly`)));

    const ensured = await provider.ensureNode({ sourceSessionId: 'source', nodeId: 'sandbox-dev', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    assert.match(String(ensured.effect), /already exist/);
    assert.equal(docker.calls.filter(call => call.args[0] === 'run').length, 1);
    await assert.rejects(() => provider.createNode({ sourceSessionId: 'source', nodeId: 'other', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /already assigned/);
    assert.equal(await provider.getDefaultCwd({ sourceSessionId: 'source', nodeId: 'sandbox-dev', context: { agent: 'main' } }), repo);
    assert.equal(await provider.invokeTool({ sourceSessionId: 'source', nodeId: 'sandbox-dev', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'sandbox-dev', cwd: repo } }), 'fixture-content');
    const inspected = await provider.inspectNode({ sourceSessionId: 'source', nodeId: 'sandbox-dev', parameters: {}, context: { agent: 'main' } });
    assert.equal((inspected.details as any).branch, 'test-branch');
    assert.match(String(inspected.dataRetention), /read-only/);

    const destroyed = await provider.destroyNode({ sourceSessionId: 'source', nodeId: 'sandbox-dev', parameters: {}, context: { agent: 'main' } });
    assert.match(String(destroyed.dataRetention), /worktree bytes/);
    assert.equal(await fs.readFile(path.join(repo, 'file.txt'), 'utf8'), 'hello\n');
    assert.deepEqual(await provider.listNodes(), []);
  } finally { await fs.remove(dir); }
});

test('Docker worktree provider rejects roots, networks, contentRef, and mismatched container identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-deny-'));
  const allowed = path.join(dir, 'allowed'); const outside = path.join(dir, 'outside'); await fs.ensureDir(allowed); await fs.ensureDir(outside);
  const repo = await makeRepo(outside); const docker = new FakeDocker();
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-deny', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [allowed], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try {
    await assert.rejects(() => provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /outside configured allowed roots/);
    const allowedRepo = await makeRepo(allowed);
    await assert.rejects(() => provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: allowedRepo, networkMode: 'bridge' }, context: { agent: 'main' } }), /networkMode/);
    await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: allowedRepo }, context: { agent: 'main' } });
    docker.container.Config.Labels['foxwarm.node'] = 'other';
    await assert.rejects(() => provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }), /does not match provider state/);
  } finally { await fs.remove(dir); }
});

test('Docker lifecycle readiness is consistent and ensure restarts or unpauses the same exact generation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-readiness-')); const repo = await makeRepo(dir); const docker = new FakeDocker();
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-readiness', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try {
    const created = await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); const id = (created.details as any).containerId; const generation = (created.details as any).generation;
    assert.equal(created.node?.availability, 'ready'); assert.equal((created.details as any).status, 'running'); assert.equal((created.details as any).availability, 'ready');

    docker.container.State = { Running: false, Paused: false, Restarting: false, Dead: false, Status: 'exited' };
    assert.equal((await provider.listNodes())[0].availability, 'offline'); const exited = await provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal(exited.node?.availability, 'offline'); assert.equal((exited.details as any).status, 'exited'); assert.equal((exited.details as any).availability, 'offline');
    const registry = new NodeProviderRegistry([provider]); await assert.rejects(() => registry.invokeTool({ sourceSessionId: 's', nodeId: 'n', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'n', cwd: repo } }), /not available/);
    await assert.rejects(() => provider.invokeTool({ sourceSessionId: 's', nodeId: 'n', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'n', cwd: repo } }), /not execution-ready.*exited/i);
    const restarted = await provider.ensureNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); assert.match(String(restarted.effect), /Restarted/); assert.equal((restarted.details as any).containerId, id); assert.equal((restarted.details as any).generation, generation); assert.equal(restarted.node?.availability, 'ready'); assert.equal((restarted.details as any).status, 'running'); assert.ok(docker.calls.some(call => call.args[0] === 'start' && call.args[1] === id)); assert.equal(docker.calls.filter(call => call.args[0] === 'run').length, 1);
    assert.equal(await provider.invokeTool({ sourceSessionId: 's', nodeId: 'n', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'n', cwd: repo } }), 'fixture-content');

    docker.container.State = { Running: true, Paused: true, Restarting: false, Dead: false, Status: 'running' }; const paused = await provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal(paused.node?.availability, 'offline'); assert.equal((paused.details as any).status, 'paused');
    const unpaused = await provider.ensureNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); assert.match(String(unpaused.effect), /Unpaused/); assert.equal((unpaused.details as any).containerId, id); assert.equal((unpaused.details as any).generation, generation); assert.ok(docker.calls.some(call => call.args[0] === 'unpause' && call.args[1] === id));

    docker.container.State = { Running: true, Paused: false, Restarting: true, Dead: false, Status: 'running' }; assert.equal((await provider.listNodes())[0].availability, 'error'); const restarting = await provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal(restarting.node?.availability, 'error'); assert.equal((restarting.details as any).status, 'restarting'); assert.equal((restarting.details as any).availability, 'error'); await assert.rejects(() => provider.ensureNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /not execution-ready.*restarting/i);
    docker.containers.clear(); assert.equal((await provider.listNodes())[0].availability, 'error'); const unavailable = await provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal(unavailable.node?.availability, 'error'); assert.equal((unavailable.details as any).status, 'unavailable'); assert.equal((unavailable.details as any).availability, 'error'); await assert.rejects(() => provider.ensureNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /container.*unavailable/i);
  } finally { docker.container && (docker.container.State = { Running: true, Paused: false, Restarting: false, Dead: false, Status: 'running' }); await provider.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await provider.shutdown(); await fs.remove(dir); }
});

test('create removes an exact container that exits before execution readiness', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-immediate-exit-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); docker.immediateExitOnRun = true;
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-immediate-exit', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try { await assert.rejects(() => provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /did not become execution-ready.*exited/i); assert.equal(docker.containers.size, 0); assert.equal(docker.calls.filter(call => call.args[0] === 'rm').length, 1); assert.deepEqual(await provider.listNodes(), []); } finally { await provider.shutdown(); await fs.remove(dir); }
});

test('stale startup configuration fences capabilities and Git status while preserving exact destroy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-stale-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const stateDir = path.join(dir, 'state');
  const base = { id: 'docker-stale', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', networkModes: ['none'] as Array<'none'>, stateDir, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  try {
    const original = new DockerWorktreeNodeProvider({ ...base, allowedWorktreeRoots: [dir] }, docker);
    await original.createNode({ sourceSessionId: 's', nodeId: 'stale-node', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    const current = new DockerWorktreeNodeProvider({ ...base, allowedWorktreeRoots: [repo] }, docker);
    assert.equal((await current.listNodes())[0].availability, 'error');
    await assert.rejects(() => current.invokeTool({ sourceSessionId: 's', nodeId: 'stale-node', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'stale-node', cwd: repo } }), /stale provider configuration/);
    const inspected = await current.inspectNode({ sourceSessionId: 's', nodeId: 'stale-node', parameters: {}, context: { agent: 'main' } });
    assert.equal((inspected.details as any).status, 'running'); assert.equal((inspected.details as any).availability, 'error'); assert.equal((inspected.details as any).configurationStatus, 'stale-config'); assert.equal(Object.prototype.hasOwnProperty.call(inspected.details, 'dirty'), false);
    await current.destroyNode({ sourceSessionId: 's', nodeId: 'stale-node', parameters: {}, context: { agent: 'main' } });
    assert.equal(docker.containers.size, 0);
  } finally { await fs.remove(dir); }
});

test('start outcome-unknown removes only an exactly corroborated orphan and crash-gap create never adopts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-orphan-')); const repo = await makeRepo(dir); const stateDir = path.join(dir, 'state');
  const config = { id: 'docker-orphan', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  try {
    const unknown = new FakeDocker(); unknown.failRunAfterCreate = true;
    await assert.rejects(() => new DockerWorktreeNodeProvider(config, unknown).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /failed to start/);
    assert.equal(unknown.containers.size, 0);

    const mismatch = new FakeDocker(); mismatch.mismatchRunAfterCreate = true; const mismatchProvider = new DockerWorktreeNodeProvider(config, mismatch);
    await assert.rejects(() => mismatchProvider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /uncorroborated runtime/);
    assert.ok(mismatch.containers.size > 0, 'mismatched container must not be removed');
    await assert.rejects(() => mismatchProvider.listNodes(), /uncorroborated crash-gap runtime/); assert.ok(mismatch.containers.size > 0);

    const crashGap = new FakeDocker(); const first = new DockerWorktreeNodeProvider(config, crashGap);
    await first.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    await fs.remove(path.join(stateDir, 'nodes.json'));
    await new DockerWorktreeNodeProvider(config, crashGap).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    assert.equal(crashGap.calls.filter(call => call.args[0] === 'run').length, 2);
    assert.equal(new Set([...crashGap.containers.values()].map(item => item.Id)).size, 1);
  } finally { await fs.remove(dir); }
});

test('linked worktree Git marker is mounted read-only and changed marker identity fails before status', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-linked-')); const { main, linked } = await makeLinkedWorktree(dir); const docker = new FakeDocker();
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-linked', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try {
    await provider.createNode({ sourceSessionId: 's', nodeId: 'linked-node', parameters: { worktreePath: linked }, context: { agent: 'main' } });
    const run = docker.calls.find(call => call.args[0] === 'run')!.args;
    assert.ok(run.includes(`type=bind,src=${path.join(linked, '.git')},dst=${path.join(linked, '.git')},readonly`));
    await fs.writeFile(path.join(linked, '.git'), `gitdir: ${path.join(main, '.git')}\n`);
    await assert.rejects(() => provider.inspectNode({ sourceSessionId: 's', nodeId: 'linked-node', parameters: {}, context: { agent: 'main' } }), /Git identity|exact existing Git/);
  } finally { await fs.remove(dir); }
});

test('provider state canonical path cannot overlap worktree or Git authority', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-overlap-')); const repo = await makeRepo(dir); const base = { id: 'docker-overlap', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  try {
    for (const stateDir of [path.join(repo, 'provider-state'), path.join(repo, '.git', 'provider-state')]) {
      await assert.rejects(() => new DockerWorktreeNodeProvider({ ...base, stateDir }, new FakeDocker()).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /must not overlap/);
    }
    const target = path.join(repo, 'symlink-state'); await fs.ensureDir(target); const link = path.join(dir, 'state-link'); await fs.symlink(target, link);
    await assert.rejects(() => new DockerWorktreeNodeProvider({ ...base, stateDir: link }, new FakeDocker()).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /must not overlap/);
    const authority = path.join(dir, 'authority'); const nestedRepo = await makeRepo(authority);
    await assert.rejects(() => new DockerWorktreeNodeProvider({ ...base, stateDir: authority }, new FakeDocker()).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: nestedRepo }, context: { agent: 'main' } }), /must not overlap/);
  } finally { await fs.remove(dir); }
});

test('cancellation is fenced before effects and active Docker start/helper waits for runner close', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-cancel-')); const repo = await makeRepo(dir); const config = { id: 'docker-cancel', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  try {
    const before = new FakeDocker(); const already = new AbortController(); already.abort();
    await assert.rejects(() => new DockerWorktreeNodeProvider(config, before).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }, { signal: already.signal }), /cancelled before provider effect/);
    assert.equal(before.calls.some(call => call.args[0] === 'run'), false);

    const activeStart = new FakeDocker(); activeStart.pauseRunUntilAbort = true; const startController = new AbortController();
    const starting = new DockerWorktreeNodeProvider(config, activeStart).createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }, { signal: startController.signal });
    while (!activeStart.calls.some(call => call.args[0] === 'run')) await new Promise(resolve => setTimeout(resolve, 1)); startController.abort();
    await assert.rejects(() => starting, /cancelled/); assert.equal(activeStart.closedAfterAbort, true); assert.equal(activeStart.containers.size, 0);

    const activeHelper = new FakeDocker(); const provider = new DockerWorktreeNodeProvider(config, activeHelper);
    await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); activeHelper.pauseExecUntilAbort = true; activeHelper.closedAfterAbort = false;
    const helperController = new AbortController(); const invoking = provider.invokeTool({ sourceSessionId: 's', nodeId: 'n', toolName: 'read', args: { filePath: 'file.txt' }, context: { agent: 'main', currentNode: 'n', cwd: repo } }, { signal: helperController.signal });
    while (!activeHelper.calls.some(call => call.args[0] === 'exec')) await new Promise(resolve => setTimeout(resolve, 1)); helperController.abort();
    await assert.rejects(() => invoking, /cancelled/); assert.equal(activeHelper.closedAfterAbort, true);
  } finally { await fs.remove(dir); }
});

test('native Docker runner rejects cancellation only after its direct child closes', async () => {
  const runner = new NativeDockerCommandRunner(process.execPath, ['-e', `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),40));setInterval(()=>{},1000)`]);
  const controller = new AbortController(); const started = Date.now(); const call = runner.run([], { signal: controller.signal, timeoutMs: 5_000 });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(() => call, /cancelled/);
  assert.ok(Date.now() - started >= 55);
});

test('deterministic Docker names distinguish full Node identity despite prefix and punctuation collisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-names-')); const docker = new FakeDocker();
  const provider = new DockerWorktreeNodeProvider({ id: 'provider:with-normalization', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  const ids = ['abcdefghijklmnopqrst-one', 'abcdefghijklmnopqrst-two', 'punctuation:a', 'punctuation-a'];
  try {
    for (let index = 0; index < ids.length; index++) {
      const repo = await makeRepo(path.join(dir, `root-${index}`));
      await provider.createNode({ sourceSessionId: 's', nodeId: ids[index], parameters: { worktreePath: repo }, context: { agent: 'main' } });
    }
    const names = docker.calls.filter(call => call.args[0] === 'run').map(call => call.args[call.args.indexOf('--name') + 1]);
    assert.equal(new Set(names).size, ids.length); assert.ok(names.every(name => name.length <= 63));
  } finally { await fs.remove(dir); }
});

test('Docker mount delimiter and control characters are rejected before run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-worktree-mounts-')); const docker = new FakeDocker();
  try {
    for (const segment of ['comma,root', 'line\nbreak']) {
      const root = path.join(dir, segment); const repo = await makeRepo(root);
      const provider = new DockerWorktreeNodeProvider({ id: 'docker-mount-path', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, `state-${crypto.randomBytes(2).toString('hex')}`), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
      await assert.rejects(() => provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /commas or control characters/);
    }
    assert.equal(docker.calls.some(call => call.args[0] === 'run'), false);
  } finally { await fs.remove(dir); }
});

test('durable destroy intent prevents state/runtime split and recovers exact committed effects', async () => {
  const make = async (suffix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-destroy-${suffix}-`)); const repo = await makeRepo(dir); const docker = new FakeDocker(); const stateDir = path.join(dir, 'state');
    const config = { id: `destroy-${suffix}`, type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
    const provider = new DockerWorktreeNodeProvider(config, docker); await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    return { dir, docker, stateDir, config, provider };
  };

  const before = await make('before');
  try {
    const original = (before.provider as any).writeState.bind(before.provider); let writes = 0;
    (before.provider as any).writeState = async (state: any) => { if (++writes === 1) throw new Error('injected'); return original(state); };
    await assert.rejects(() => before.provider.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }), /commit destroy intent/);
    assert.ok(before.docker.container, 'container remains when intent persistence fails');
  } finally { await fs.remove(before.dir); }

  const pending = await make('pending');
  try {
    pending.docker.failRmCount = 1;
    await assert.rejects(() => pending.provider.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }), /committed destroy/);
    assert.ok(pending.docker.container); assert.deepEqual(await new DockerWorktreeNodeProvider(pending.config, pending.docker).listNodes(), []); assert.equal(pending.docker.containers.size, 0);
  } finally { await fs.remove(pending.dir); }

  const after = await make('after');
  try {
    const original = (after.provider as any).writeState.bind(after.provider); let writes = 0;
    (after.provider as any).writeState = async (state: any) => { writes++; if (writes === 2) throw new Error('injected final'); return original(state); };
    await assert.rejects(() => after.provider.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }), /finalize committed destroy/);
    assert.equal(after.docker.containers.size, 0); assert.deepEqual(await new DockerWorktreeNodeProvider(after.config, after.docker).listNodes(), []);
  } finally { await fs.remove(after.dir); }

  const mismatch = await make('mismatch');
  try {
    mismatch.docker.failRmCount = 1;
    await assert.rejects(() => mismatch.provider.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }), /committed destroy/);
    mismatch.docker.container.Config.Labels['foxwarm.node'] = 'other';
    await assert.rejects(() => new DockerWorktreeNodeProvider(mismatch.config, mismatch.docker).listNodes(), /does not match provider state/);
    assert.ok(mismatch.docker.container, 'mismatched pending runtime is not removed');
  } finally { await fs.remove(mismatch.dir); }
});

test('inert Git evidence executes neither fsmonitor nor attribute filters and never refreshes the index', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-git-inert-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const fsmonitorTouched = path.join(dir, 'fsmonitor-ran'); const filterTouched = path.join(dir, 'filter-ran'); const fsmonitor = path.join(dir, 'fsmonitor.sh'); const filter = path.join(dir, 'filter.sh');
  await fs.writeFile(path.join(repo, '.gitattributes'), 'file.txt filter=evil\n'); await execFileAsync('git', ['-C', repo, 'add', '.gitattributes']); await execFileAsync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'attributes']);
  await fs.writeFile(fsmonitor, `#!/bin/sh\nprintf ran > '${fsmonitorTouched}'\nexit 0\n`, { mode: 0o755 }); await fs.writeFile(filter, `#!/bin/sh\nprintf ran > '${filterTouched}'\ncat\n`, { mode: 0o755 });
  await execFileAsync('git', ['-C', repo, 'config', 'core.fsmonitor', fsmonitor]); await execFileAsync('git', ['-C', repo, 'config', 'filter.evil.clean', filter]); await execFileAsync('git', ['-C', repo, 'config', 'filter.evil.process', filter]);
  await fs.writeFile(path.join(repo, 'file.txt'), 'stale and changed\n');
  const index = path.join(repo, '.git', 'index'); const before = await fs.stat(index); const beforeHash = crypto.createHash('sha256').update(await fs.readFile(index)).digest('hex');
  const provider = new DockerWorktreeNodeProvider({ id: 'git-inert', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try {
    const results = [
      await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }),
      await provider.ensureNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }),
      await provider.inspectNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }),
    ];
    const after = await fs.stat(index); const afterHash = crypto.createHash('sha256').update(await fs.readFile(index)).digest('hex');
    assert.equal(await fs.pathExists(fsmonitorTouched), false); assert.equal(await fs.pathExists(filterTouched), false); assert.equal(afterHash, beforeHash); assert.equal(after.mtimeMs, before.mtimeMs);
    assert.ok(results.every(result => !Object.prototype.hasOwnProperty.call(result.details, 'dirty')));
  } finally { await fs.remove(dir); }
});

test('forged linked marker to an unrelated repository is rejected before Docker effect', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-git-forged-')); const allowed = path.join(dir, 'allowed'); const external = await makeRepo(path.join(dir, 'external-root')); const forged = path.join(allowed, 'forged'); await fs.ensureDir(forged); await fs.writeFile(path.join(forged, '.git'), `gitdir: ${path.join(external, '.git')}\n`); const docker = new FakeDocker();
  try {
    const provider = new DockerWorktreeNodeProvider({ id: 'git-forged', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [allowed], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
    await assert.rejects(() => provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: forged }, context: { agent: 'main' } }), /exact existing Git worktree/);
    assert.equal(docker.calls.some(call => call.args[0] === 'run'), false);
  } finally { await fs.remove(dir); }
});

test('state authority and runtime uid/gid changes are full identity and never delete or duplicate old runtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-authority-identity-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const base = { id: 'authority-id', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  try {
    const original = new DockerWorktreeNodeProvider({ ...base, stateDir: path.join(dir, 'state-a') }, docker, { uid: 1001, gid: 1001 });
    await original.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    const changedState = new DockerWorktreeNodeProvider({ ...base, stateDir: path.join(dir, 'state-b') }, docker, { uid: 1001, gid: 1001 });
    await assert.rejects(() => changedState.listNodes(), /different state\/config identity/);
    await assert.rejects(() => changedState.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /different state\/config identity/);
    assert.equal(new Set([...docker.containers.values()].map(item => item.Id)).size, 1);
    const changedUid = new DockerWorktreeNodeProvider({ ...base, stateDir: path.join(dir, 'state-a') }, docker, { uid: 2002, gid: 2002 });
    assert.equal((await changedUid.listNodes())[0].availability, 'error');
    await assert.rejects(() => changedUid.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }), /already exists/);
    assert.equal(new Set([...docker.containers.values()].map(item => item.Id)).size, 1);
  } finally { await fs.remove(dir); }
});

test('Docker runner handles early stdin close and rejects oversized helper input before spawn', async () => {
  const early = new NativeDockerCommandRunner(process.execPath, ['-e', 'process.stdin.destroy();process.exit(0)']);
  await early.run([], { input: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 5_000 }).catch(error => assert.match(String(error), /failure/));
  const neverSpawn = new NativeDockerCommandRunner('/definitely/not/a/command', []);
  await assert.rejects(() => neverSpawn.run([], { input: 'x'.repeat(8 * 1024 * 1024 + 1) }), /input/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-helper-input-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const provider = new DockerWorktreeNodeProvider({ id: 'helper-input', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker);
  try {
    await provider.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    await assert.rejects(() => provider.invokeTool({ sourceSessionId: 's', nodeId: 'n', toolName: 'write', args: { filePath: 'large', content: 'x'.repeat(8 * 1024 * 1024) }, context: { agent: 'main', currentNode: 'n', cwd: repo } }), /fixed 8 MiB/);
    assert.equal(docker.calls.filter(call => call.args[0] === 'exec').length, 0);
  } finally { await fs.remove(dir); }
});

test('resident Docker exec reuses canonical foreground, cwd, failure, artifact-read, and environment semantics', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-exec-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const launches: string[][] = [];
  const launcher: typeof spawn = ((command: any, args: any, options: any) => { launches.push([...args]); return localDockerExecLauncher(command, args, options); }) as typeof spawn;
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-exec', type: 'docker-worktree', command: 'docker-launcher', args: ['--fixed'], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker, undefined, launcher, async () => {});
  try {
    const created = await provider.createNode({ sourceSessionId: 'session-exec', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    const artifactDir = (created.details as any).artifactDir as string; await fs.ensureDir(path.join(repo, 'sub'));
    const success = await provider.invokeTool({ sourceSessionId: 'session-exec', nodeId: 'n', toolName: 'exec', args: { command: 'cd sub; printf hello', timeout: 5 }, context: { agent: 'main', currentNode: 'n', cwd: repo, deferSessionCwdSync: true } }) as any;
    assert.match(success.output, /hello/); assert.equal(success.__execBatchCwdSync.nextCwd, path.join(repo, 'sub'));
    const failure = await provider.invokeTool({ sourceSessionId: 'session-exec', nodeId: 'n', toolName: 'exec', args: { command: 'printf bad; exit 7', timeout: 5 }, context: { agent: 'main', currentNode: 'n', cwd: repo, deferSessionCwdSync: true } }) as any;
    assert.match(failure.output, /bad/); assert.match(failure.output, /exit code:\s*7/i);
    const envArgs = launches[0].filter((_value, index, all) => index > 0 && all[index - 1] === '-e');
    assert.ok(envArgs.every(value => /^(TERM|FOXWARM_EXEC_[A-Z_]+)=/.test(value))); assert.equal(envArgs.some(value => /HOME|DOCKER|SESSION/.test(value)), false);
    const artifactFiles = (await fs.readdir(artifactDir, { recursive: true }) as string[]).map(item => path.join(artifactDir, item)); const logPath = artifactFiles.find(item => item.endsWith('.log')); assert.ok(logPath);
    assert.match(String(await provider.invokeTool({ sourceSessionId: 'session-exec', nodeId: 'n', toolName: 'read', args: { filePath: logPath }, context: { agent: 'main', currentNode: 'n', cwd: repo } })), /hello/);
    await assert.rejects(() => provider.invokeTool({ sourceSessionId: 'session-exec', nodeId: 'n', toolName: 'write', args: { filePath: path.join(artifactDir, 'forbidden'), content: 'x' }, context: { agent: 'main', currentNode: 'n', cwd: repo } }), /outside.*worktree|escapes/i);
    const operations = (provider as any).createDockerProcessOperations((await (provider as any).readState()).nodes[0]);
    await assert.rejects(() => operations.launch({ command: '/bin/bash', args: ['/tmp/not-managed.sh'], cwd: repo, env: {}, detached: true, windowsHide: true }), /script escaped/);
  } finally { await provider.destroyNode({ sourceSessionId: 'session-exec', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await fs.remove(dir); }
});

test('resident Docker exec times out to background, delivers exact event, survives destroy truthfully, and recreates a new generation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-background-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const events: Array<{ sessionId: string; message: string }> = [];
  const children: number[] = []; const launcher: typeof spawn = ((command: any, args: any, options: any) => { const child = localDockerExecLauncher(command, args, options); if (child.pid) children.push(child.pid); return child; }) as typeof spawn;
  docker.onRm = () => { for (const pid of children.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch {} } };
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-bg', type: 'docker-worktree', command: 'docker-launcher', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, docker, undefined, launcher, async (sessionId, message) => { events.push({ sessionId, message }); });
  try {
    const first = await provider.createNode({ sourceSessionId: 'session-bg', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); const firstArtifact = (first.details as any).artifactDir;
    const timeout = String(await provider.invokeTool({ sourceSessionId: 'session-bg', nodeId: 'n', toolName: 'exec', args: { command: 'sleep 2; printf background-done', timeout: 1 }, context: { agent: 'main', currentNode: 'n', cwd: repo } }));
    assert.match(timeout, /Switched to background/); assert.match(timeout, /Docker boundary; launcher PID/); assert.doesNotMatch(timeout, /managed shell-script root PID/);
    for (let i = 0; i < 30 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(events[0]?.sessionId, 'session-bg'); assert.match(events[0]?.message || '', /Background Process Finished/);
    const log = /Command output in (.+)$/.exec(events[0].message)![1]; assert.match(String(await provider.invokeTool({ sourceSessionId: 'session-bg', nodeId: 'n', toolName: 'read', args: { filePath: log }, context: { agent: 'main', currentNode: 'n', cwd: repo } })), /background-done/);
    const active = String(await provider.invokeTool({ sourceSessionId: 'session-bg', nodeId: 'n', toolName: 'exec', args: { command: 'sleep 20', timeout: 1 }, context: { agent: 'main', currentNode: 'n', cwd: repo } })); assert.match(active, /Switched to background/);
    const destroyed = await provider.destroyNode({ sourceSessionId: 'session-bg', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal((destroyed.details as any).artifactDir, firstArtifact); assert.ok(await fs.pathExists(firstArtifact));
    for (let i = 0; i < 30 && events.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(events.length, 2); assert.match(events[1].message, /no status file was written/i);
    const second = await provider.createNode({ sourceSessionId: 'session-bg', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); assert.notEqual((second.details as any).artifactDir, firstArtifact);
  } finally { await provider.destroyNode({ sourceSessionId: 'session-bg', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await fs.remove(dir); }
});

test('provider startup reconciles an already-finished background exec without a model or list call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-restart-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const events: string[] = [];
  const config = { id: 'docker-restart', type: 'docker-worktree' as const, command: 'docker-launcher', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  const first = new DockerWorktreeNodeProvider(config, docker, undefined, localDockerExecLauncher, async () => {});
  try {
    const created = await first.createNode({ sourceSessionId: 'restart-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); const artifact = (created.details as any).artifactDir; const dateDir = path.join(artifact, 'fixture'); await fs.ensureDir(dateDir);
    const logPath = path.join(dateDir, 'done.log'); const statusPath = `${logPath}.status.json`; const cwdPath = `${logPath}.cwd.txt`; await fs.writeFile(logPath, 'restart-output\n'); await fs.writeJson(statusPath, { exitCode: 0, finishedAt: new Date().toISOString() }); await fs.writeFile(cwdPath, `${repo}\n`);
    await fs.writeJson(path.join(artifact, 'running-exec.json'), { execs: [{ id: 'exec_restart_fixture', pid: 99999999, sessionId: 'restart-session', agentName: 'main', nodeId: 'n', command: 'printf restart-output', initialCwd: repo, logPath, statusPath, cwdPath, startedAt: Date.now() - 1000, notifyOnCompletion: true }] });
    const restarted = new DockerWorktreeNodeProvider(config, docker, undefined, localDockerExecLauncher, async (sessionId, message) => { events.push(`${sessionId}:${message}`); });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(events.length, 0, 'constructor does not fire-and-forget reconciliation');
    await restarted.initialize();
    for (let i = 0; i < 40 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(events[0] || '', /^restart-session:Background Process Finished/); assert.equal(await fs.pathExists(path.join(artifact, 'running-exec.json')), true); await restarted.shutdown();
  } finally { await first.destroyNode({ sourceSessionId: 'restart-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await first.shutdown(); await fs.remove(dir); }
});

test('restart liveness follows exact container script identity instead of dead or reused launcher PID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-script-truth-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const events: string[] = [];
  const config = { id: 'docker-script-truth', type: 'docker-worktree' as const, command: 'docker-launcher', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  const first = new DockerWorktreeNodeProvider(config, docker, undefined, localDockerExecLauncher, async () => {}); let restarted: DockerWorktreeNodeProvider | undefined;
  try {
    const created = await first.createNode({ sourceSessionId: 'truth-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); const artifact = (created.details as any).artifactDir; const dateDir = path.join(artifact, 'fixture'); await fs.ensureDir(dateDir);
    const scriptPath = path.join(dateDir, 'managed.command.sh'); const logPath = path.join(dateDir, 'managed.log'); const statusPath = `${logPath}.status.json`; const cwdPath = `${logPath}.cwd.txt`; await fs.writeFile(scriptPath, '#!/bin/bash\n', { mode: 0o700 }); await fs.writeFile(logPath, 'still-running\n');
    await fs.writeJson(path.join(artifact, 'running-exec.json'), { execs: [{ id: 'exec_script_truth', pid: process.pid, sessionId: 'truth-session', agentName: 'main', nodeId: 'n', command: 'sleep 20', initialCwd: repo, logPath, statusPath, cwdPath, scriptPath, startedAt: Date.now() - 10_000, notifyOnCompletion: true }] });
    docker.topRows = [`424200 1 /bin/bash ${scriptPath}`, '424201 424200 sleep 20'];
    await first.shutdown(); restarted = new DockerWorktreeNodeProvider(config, docker, undefined, localDockerExecLauncher, async (_sessionId, message) => { events.push(message); }); await restarted.initialize();
    assert.equal(events.length, 0, 'unrelated live host PID cannot replace exact container script truth');
    docker.topRows = []; const runtime = await [...(restarted as any).execRuntimes.values()][0]; await runtime.reconcileNow();
    assert.match(events[0] || '', /no status file was written/i);
  } finally { await restarted?.destroyNode({ sourceSessionId: 'truth-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await restarted?.shutdown(); await first.shutdown(); await fs.remove(dir); }
});

test('destroyed generation survives restart until exact completion then retires without runtime growth', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-retired-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const children: number[] = []; const events: string[] = [];
  const launcher: typeof spawn = ((command: any, args: any, options: any) => { const child = localDockerExecLauncher(command, args, options); if (child.pid) children.push(child.pid); return child; }) as typeof spawn; docker.onRm = () => { for (const pid of children.splice(0)) try { process.kill(-pid, 'SIGKILL'); } catch {} };
  const config = { id: 'docker-retired', type: 'docker-worktree' as const, command: 'docker-launcher', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  const first = new DockerWorktreeNodeProvider(config, docker, undefined, launcher, async () => {}); let restarted: DockerWorktreeNodeProvider | undefined;
  try {
    const original = await first.createNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
    await first.invokeTool({ sourceSessionId: 'retired-session', nodeId: 'n', toolName: 'exec', args: { command: 'sleep 20', timeout: 1 }, context: { agent: 'main', currentNode: 'n', cwd: repo } });
    await first.destroyNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); const persisted = await fs.readJson(path.join(config.stateDir, 'nodes.json')); assert.equal(persisted.retired.length, 1);
    await first.shutdown(); restarted = new DockerWorktreeNodeProvider(config, docker, undefined, launcher, async (_sessionId, message) => { events.push(message); }); await restarted.initialize();
    const replacement = await restarted.createNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); assert.notEqual((replacement.details as any).artifactDir, (original.details as any).artifactDir);
    for (let i = 0; i < 40 && events.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 150)); assert.match(events[0] || '', /no status file was written/i);
    for (let i = 0; i < 30; i++) { const state = await fs.readJson(path.join(config.stateDir, 'nodes.json')); if (state.retired.length === 0) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal((await fs.readJson(path.join(config.stateDir, 'nodes.json'))).retired.length, 0); assert.equal((restarted as any).execRuntimes.size, 1);
    for (let i = 0; i < 3; i++) { await restarted.destroyNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal((restarted as any).execRuntimes.size, 0); await restarted.createNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); assert.equal((restarted as any).execRuntimes.size, 1); }
  } finally { await restarted?.destroyNode({ sourceSessionId: 'retired-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await restarted?.shutdown(); await first.shutdown(); await fs.remove(dir); }
});

test('provider initialization failure is awaited and observable and shutdown clears runtime ownership', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-init-failure-')); const stateDir = path.join(dir, 'state'); await fs.ensureDir(stateDir); await fs.writeJson(path.join(stateDir, 'nodes.json'), { version: 3, nodes: 'invalid', destroys: [], retired: [] });
  const provider = new DockerWorktreeNodeProvider({ id: 'docker-init-failure', type: 'docker-worktree', command: 'docker', args: [], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'], stateDir, memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }, new FakeDocker());
  try { await assert.rejects(() => provider.initialize(), /state is invalid/); await provider.shutdown(); await provider.shutdown(); assert.equal((provider as any).execRuntimes.size, 0); } finally { await fs.remove(dir); }
});

test('provider reads version 2 authority and writes version 3 retired-generation schema', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-state-migrate-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const config = { id: 'docker-state-migrate', type: 'docker-worktree' as const, command: 'docker', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' };
  const first = new DockerWorktreeNodeProvider(config, docker); let migrated: DockerWorktreeNodeProvider | undefined;
  try {
    await first.createNode({ sourceSessionId: 's', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); await first.shutdown(); const statePath = path.join(config.stateDir, 'nodes.json'); const old = await fs.readJson(statePath); old.version = 2; delete old.retired; await fs.writeJson(statePath, old);
    migrated = new DockerWorktreeNodeProvider(config, docker); await migrated.initialize(); const current = await fs.readJson(statePath); assert.equal(current.version, 3); assert.deepEqual(current.retired, []);
  } finally { await migrated?.destroyNode({ sourceSessionId: 's', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await migrated?.shutdown(); await first.shutdown(); await fs.remove(dir); }
});

test('concurrent foreground finalization retires a destroyed generation without restart or runtime growth', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-docker-foreground-retire-')); const repo = await makeRepo(dir); const docker = new FakeDocker(); const children: number[] = [];
  const launcher: typeof spawn = ((command: any, args: any, options: any) => { const child = localDockerExecLauncher(command, args, options); if (child.pid) children.push(child.pid); return child; }) as typeof spawn; docker.onRm = () => { for (const pid of children.splice(0)) try { process.kill(-pid, 'SIGKILL'); } catch {} };
  const config = { id: 'docker-foreground-retire', type: 'docker-worktree' as const, command: 'docker-launcher', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }; const provider = new DockerWorktreeNodeProvider(config, docker, undefined, launcher, async () => {});
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      await provider.createNode({ sourceSessionId: 'foreground-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } });
      const foreground = provider.invokeTool({ sourceSessionId: 'foreground-session', nodeId: 'n', toolName: 'exec', args: { command: 'sleep 20', timeout: 20 }, context: { agent: 'main', currentNode: 'n', cwd: repo } }); await new Promise(resolve => setTimeout(resolve, 150));
      await provider.destroyNode({ sourceSessionId: 'destroy-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }); assert.equal((await fs.readJson(path.join(config.stateDir, 'nodes.json'))).retired.length, 1);
      const foregroundResult: any = await foreground; assert.match(String(foregroundResult?.output ?? foregroundResult), /no status file was written/i);
      for (let i = 0; i < 40; i++) { if ((await fs.readJson(path.join(config.stateDir, 'nodes.json'))).retired.length === 0) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.equal((await fs.readJson(path.join(config.stateDir, 'nodes.json'))).retired.length, 0); assert.equal((provider as any).execRuntimes.size, 0);
    }
  } finally { await provider.destroyNode({ sourceSessionId: 'foreground-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await provider.shutdown(); await fs.remove(dir); }
});

test('stopped exact container is terminal for restart fallback while running top failure stays pending', async () => {
  const makeFixture = async (suffix: string) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `foxwarm-docker-top-${suffix}-`)); const repo = await makeRepo(dir); const docker = new FakeDocker(); const events: string[] = [];
    const config = { id: `docker-top-${suffix}`, type: 'docker-worktree' as const, command: 'docker-launcher', args: [] as string[], image: 'fixture', allowedWorktreeRoots: [dir], networkModes: ['none'] as Array<'none'>, stateDir: path.join(dir, 'state'), memory: '1g', cpus: 1, pidsLimit: 32, tmpfsSize: '32m' }; const first = new DockerWorktreeNodeProvider(config, docker, undefined, localDockerExecLauncher, async () => {});
    const created = await first.createNode({ sourceSessionId: 'top-session', nodeId: 'n', parameters: { worktreePath: repo }, context: { agent: 'main' } }); const artifact = (created.details as any).artifactDir; const dateDir = path.join(artifact, 'fixture'); await fs.ensureDir(dateDir); const scriptPath = path.join(dateDir, 'exec_top.command.sh'); const logPath = path.join(dateDir, 'top.log'); const statusPath = `${logPath}.status.json`; const cwdPath = `${logPath}.cwd.txt`; await fs.writeFile(scriptPath, '#!/bin/bash\n'); await fs.writeFile(logPath, 'partial\n');
    await fs.writeJson(path.join(artifact, 'running-exec.json'), { execs: [{ id: 'exec_top', pid: process.pid, sessionId: 'top-session', agentName: 'main', nodeId: 'n', command: 'sleep 20', initialCwd: repo, logPath, statusPath, cwdPath, scriptPath, startedAt: Date.now() - 10_000, notifyOnCompletion: true }] }); await first.shutdown();
    return { dir, repo, docker, events, config, first, artifact, scriptPath, statusPath };
  };

  const stopped = await makeFixture('stopped'); let stoppedProvider: DockerWorktreeNodeProvider | undefined;
  try {
    const statePath = path.join(stopped.config.stateDir, 'nodes.json'); const state = await fs.readJson(statePath); state.retired = [{ node: state.nodes[0], retiredAt: Date.now() }]; state.nodes = []; await fs.writeJson(statePath, state); stopped.docker.container.State.Running = false; stopped.docker.failTopCount = 1;
    stoppedProvider = new DockerWorktreeNodeProvider(stopped.config, stopped.docker, undefined, localDockerExecLauncher, async (_sessionId, message) => { stopped.events.push(message); }); await stoppedProvider.initialize();
    assert.equal(stopped.events.length, 1); assert.match(stopped.events[0], /no status file was written/i); assert.equal((await fs.readJson(statePath)).retired.length, 0); assert.equal((stoppedProvider as any).execRuntimes.size, 0);
  } finally { await stoppedProvider?.shutdown(); await stopped.first.shutdown(); await fs.remove(stopped.dir); }

  const running = await makeFixture('running'); let runningProvider: DockerWorktreeNodeProvider | undefined;
  try {
    running.docker.failTopCount = 10; runningProvider = new DockerWorktreeNodeProvider(running.config, running.docker, undefined, localDockerExecLauncher, async (_sessionId, message) => { running.events.push(message); }); await runningProvider.initialize(); const runtime = await [...(runningProvider as any).execRuntimes.values()][0];
    assert.equal(running.events.length, 0); assert.equal(runtime.listRunningExecs().length, 1); await runtime.reconcileNow(); assert.equal(running.events.length, 0); assert.equal(runtime.listRunningExecs().length, 1);
    running.docker.failTopCount = 0; running.docker.topRows = [`777 1 /bin/bash ${running.scriptPath}`, '778 777 sleep 20']; await runtime.reconcileNow(); assert.equal(running.events.length, 0); assert.equal(runtime.listRunningExecs().length, 1);
    await fs.writeJson(running.statusPath, { exitCode: 0, finishedAt: new Date().toISOString() }); await runtime.reconcileNow(); assert.equal(running.events.length, 1); assert.equal(runtime.listRunningExecs().length, 0);
  } finally { await runningProvider?.destroyNode({ sourceSessionId: 'top-session', nodeId: 'n', parameters: {}, context: { agent: 'main' } }).catch(() => {}); await runningProvider?.shutdown(); await running.first.shutdown(); await fs.remove(running.dir); }
});
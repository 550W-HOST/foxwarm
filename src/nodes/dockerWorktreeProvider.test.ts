import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import '../llm';
import { DockerCommandError, DockerWorktreeNodeProvider, NativeDockerCommandRunner, type DockerCommandRunner } from './dockerWorktreeProvider';

const execFileAsync = promisify(execFile);

class FakeDocker implements DockerCommandRunner {
  readonly calls: Array<{ args: string[]; input?: string }> = [];
  readonly containers = new Map<string, any>();
  failRunAfterCreate = false;
  mismatchRunAfterCreate = false;
  pauseRunUntilAbort = false;
  pauseExecUntilAbort = false;
  failRmCount = 0;
  closedAfterAbort = false;
  get container(): any { return [...this.containers.values()][0]; }
  async run(args: string[], options: { input?: string; signal?: AbortSignal } = {}) {
    this.calls.push({ args: [...args], input: options.input });
    if (options.signal?.aborted) throw new DockerCommandError('cancelled');
    if (args[0] === 'run') {
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index++) if (args[index] === '--label') { const split = args[++index].indexOf('='); labels[args[index].slice(0, split)] = args[index].slice(split + 1); }
      const image = args[args.length - 4]; const network = args[args.indexOf('--network') + 1]; const user = args[args.indexOf('--user') + 1];
      const name = args[args.indexOf('--name') + 1]; const id = crypto.createHash('sha256').update(`${name}-${this.containers.size}`).digest('hex');
      const container = { Id: id, Name: `/${name}`, Config: { Labels: labels, Image: image, User: user }, HostConfig: { NetworkMode: network }, State: { Running: true, Status: 'running' } };
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
      const selected = filter.startsWith('name=^/') ? unique.filter(item => filter === `name=^${item.Name}$`) : unique;
      return { stdout: selected.map(item => item.Id).join('\n'), stderr: '' };
    }
    if (args[0] === 'rm') { if (this.failRmCount > 0) { this.failRmCount--; throw new DockerCommandError('failure'); } const container = this.containers.get(args[args.length - 1]); if (container) for (const [key, value] of this.containers) if (value === container) this.containers.delete(key); return { stdout: '', stderr: '' }; }
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
    assert.deepEqual(created.node?.tools.map(tool => tool.name), ['read', 'write', 'edit', 'apply_patch']);
    assert.equal(created.node?.tools.some(tool => tool.name === 'exec'), false);
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
    await assert.rejects(() => provider.invokeTool({ sourceSessionId: 'source', nodeId: 'sandbox-dev', toolName: 'exec', args: { command: 'true' }, context: { agent: 'main' } }), /not available/);
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
    assert.equal((inspected.details as any).status, 'stale-config'); assert.equal(Object.prototype.hasOwnProperty.call(inspected.details, 'dirty'), false);
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
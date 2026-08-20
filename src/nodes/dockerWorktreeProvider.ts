import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promises as nativeFs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import fs from 'fs-extra';
import path from 'node:path';
import { promisify } from 'node:util';
import { STATE_DIR, type NormalizedDockerWorktreeNodeProviderConfig } from '../config';
import { CLI_NODE_CAPABILITIES } from '../../packages/shared/dist/nodeCapabilities';
import { readFileToolPath } from '../../packages/shared/dist/fileToolCore';
import type { ProcessOperations, ProcessLaunchRequest } from '../../packages/shared/dist/processOperations';
import { createExecRuntime, type ExecRuntime } from '../execManager';
import { tool_exec } from '../tools/execTools';
import * as sessionManager from '../sessionManager';
import { logger } from '../common';
import {
  NodeProviderError, type NodeDefaultCwdRequest, type NodeDescriptor, type NodeLifecycleNodeRequest, type NodeLifecycleProviderRequest,
  type NodeLifecycleResult, type NodeProvider, type NodeProviderCallOptions, type NodeToolRequest,
} from './providerRegistry';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const HELPER_PATH = '/opt/foxwarm-sandbox-runtime/invoke.bundle.js';
const TOOLS = new Set(['read', 'write', 'edit', 'apply_patch', 'exec']);
const TOOL_DESCRIPTORS = CLI_NODE_CAPABILITIES.tools.filter(tool => TOOLS.has(tool.name)).map(tool => ({ ...tool }));

type ProviderNodeState = {
  nodeId: string; worktreePath: string; gitMarkerPath: string; gitMarkerType: 'file' | 'directory'; gitDir: string; gitCommonDir: string; image: string; networkMode: 'none' | 'bridge';
  containerId: string; containerName: string; configHash: string; generation: string; artifactDir: string; createdAt: number; uid: number; gid: number;
};
type DestroyIntent = { node: ProviderNodeState; requestedAt: number };
type RetiredGeneration = { node: ProviderNodeState; retiredAt: number };
type ProviderState = { version: 3; nodes: ProviderNodeState[]; destroys: DestroyIntent[]; retired: RetiredGeneration[] };
type DockerResult = { stdout: string; stderr: string };

export interface DockerCommandRunner {
  run(args: string[], options?: { input?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<DockerResult>;
}

export class DockerCommandError extends Error {
  constructor(public readonly reason: 'start' | 'failure' | 'timeout' | 'output' | 'input' | 'cancelled') {
    super(`Docker command ${reason}.`);
  }
}

export class NativeDockerCommandRunner implements DockerCommandRunner {
  constructor(private readonly command: string, private readonly fixedArgs: string[]) {}
  run(args: string[], options: { input?: string; timeoutMs?: number; maxOutputBytes?: number; signal?: AbortSignal } = {}): Promise<DockerResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new DockerCommandError('cancelled')); return; }
      if (Buffer.byteLength(options.input || '', 'utf8') > MAX_OUTPUT) { reject(new DockerCommandError('input')); return; }
      const child = spawn(this.command, [...this.fixedArgs, ...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = []; let size = 0; let settled = false; let terminal: DockerCommandError | undefined; let killTimer: NodeJS.Timeout | undefined;
      const limit = options.maxOutputBytes || MAX_OUTPUT;
      const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); options.signal?.removeEventListener('abort', onAbort); };
      const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); error ? reject(error) : resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); };
      const terminate = (reason: DockerCommandError['reason']) => {
        if (!terminal) terminal = new DockerCommandError(reason);
        try { child.kill('SIGTERM'); } catch {}
        if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
      };
      const onAbort = () => terminate('cancelled');
      const timer = setTimeout(() => terminate('timeout'), options.timeoutMs || 30_000);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => finish(new DockerCommandError('start')));
      child.stdin.on('error', () => terminate('failure'));
      for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) terminate('output'); else target.push(chunk); });
      child.on('close', code => terminal ? finish(terminal) : code === 0 ? finish() : finish(new DockerCommandError('failure')));
      try { child.stdin.end(options.input || ''); } catch { terminate('failure'); }
    });
  }
}

function safeId(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48); }
function inside(root: string, candidate: string): boolean { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]): void { const extra = Object.keys(value).find(key => !allowed.includes(key)); if (extra) throw new NodeProviderError('DOCKER_WORKTREE_INVALID_PARAMETERS', `Docker worktree parameters do not accept \`${extra}\`.`); }
function canonicalPotentialPath(value: string): string {
  let current = path.resolve(value); const suffix: string[] = [];
  while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) break; suffix.unshift(path.basename(current)); current = parent; }
  const base = fs.existsSync(current) ? fs.realpathSync(current) : current;
  return path.join(base, ...suffix);
}
function assertDockerMountPath(value: string): void {
  if (/[,\u0000-\u001f\u007f]/.test(value)) throw new NodeProviderError('DOCKER_WORKTREE_MOUNT_PATH_INVALID', 'Docker worktree and Git mount paths must not contain commas or control characters.');
}

export class DockerWorktreeNodeProvider implements NodeProvider {
  readonly id: string;
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly configHash: string;
  private readonly allowedRoots: string[];
  private readonly runtimeUid: number;
  private readonly runtimeGid: number;
  private readonly execRuntimes = new Map<string, Promise<ExecRuntime>>();
  private stateMutation: Promise<void> = Promise.resolve();
  private initializationPromise?: Promise<void>;
  private initialized = false;
  private shutdownStarted = false;

  constructor(private readonly config: NormalizedDockerWorktreeNodeProviderConfig, private readonly docker: DockerCommandRunner = new NativeDockerCommandRunner(config.command, config.args), runtimeIdentity?: { uid: number; gid: number }, private readonly launchProcess: typeof spawn = spawn,
    private readonly queueSystemEvent: (sessionId: string, message: string) => Promise<void> = (sessionId, message) => sessionManager.queueSessionSystemEvent(sessionId, message, 'background')) {
    this.id = config.id;
    this.stateDir = canonicalPotentialPath(config.stateDir || path.join(STATE_DIR, 'node-providers', config.id));
    this.statePath = path.join(this.stateDir, 'nodes.json');
    this.allowedRoots = config.allowedWorktreeRoots.map(canonicalPotentialPath).sort();
    this.runtimeUid = runtimeIdentity?.uid ?? process.getuid?.() ?? 0; this.runtimeGid = runtimeIdentity?.gid ?? process.getgid?.() ?? 0;
    this.configHash = crypto.createHash('sha256').update(JSON.stringify({
      command: config.command, args: config.args, image: config.image, networkModes: config.networkModes,
      allowedWorktreeRoots: this.allowedRoots, stateDir: this.stateDir, runtimeUid: this.runtimeUid, runtimeGid: this.runtimeGid,
      memory: config.memory, cpus: config.cpus, pidsLimit: config.pidsLimit, tmpfsSize: config.tmpfsSize,
      securityProfile: 2,
    })).digest('hex');
  }

  private async readState(): Promise<ProviderState> {
    try {
      const stat = await fs.stat(this.statePath);
      if (stat.size > 1024 * 1024) throw new Error();
      const raw = await fs.readJson(this.statePath);
      if ((raw?.version !== 2 && raw?.version !== 3) || !Array.isArray(raw.nodes) || raw.nodes.length > 100 || !Array.isArray(raw.destroys) || raw.destroys.length > 100
        || (raw.version === 3 && (!Array.isArray(raw.retired) || raw.retired.length > 200))) throw new Error();
      const parseNode = (node: any): ProviderNodeState => {
        if (!node || typeof node !== 'object' || Object.keys(node).some(key => !['nodeId','worktreePath','gitMarkerPath','gitMarkerType','gitDir','gitCommonDir','image','networkMode','containerId','containerName','configHash','generation','artifactDir','createdAt','uid','gid'].includes(key))
          || typeof node.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(node.nodeId)
          || !['worktreePath','gitMarkerPath','gitDir','gitCommonDir','image','containerId','containerName','generation','artifactDir'].every(key => typeof node[key] === 'string' && node[key].length > 0 && node[key].length <= 4096)
          || (node.gitMarkerType !== 'file' && node.gitMarkerType !== 'directory')
          || typeof node.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(node.configHash)
          || !/^[a-f0-9]{32}$/.test(node.generation) || node.artifactDir !== path.join(this.stateDir, 'exec-artifacts', safeId(node.nodeId), node.generation)
          || (node.networkMode !== 'none' && node.networkMode !== 'bridge') || !Number.isSafeInteger(node.createdAt) || node.createdAt < 0
          || !Number.isSafeInteger(node.uid) || node.uid < 0 || !Number.isSafeInteger(node.gid) || node.gid < 0) throw new Error();
        return node as ProviderNodeState;
      };
      const nodes: ProviderNodeState[] = raw.nodes.map(parseNode);
      const destroys: DestroyIntent[] = raw.destroys.map((intent: any) => {
        if (!intent || typeof intent !== 'object' || Object.keys(intent).some(key => key !== 'node' && key !== 'requestedAt')
          || !Number.isSafeInteger(intent.requestedAt) || intent.requestedAt < 0) throw new Error();
        return { node: parseNode(intent.node), requestedAt: intent.requestedAt };
      });
      const retired: RetiredGeneration[] = (raw.version === 3 ? raw.retired : []).map((item: any) => {
        if (!item || typeof item !== 'object' || Object.keys(item).some(key => key !== 'node' && key !== 'retiredAt')
          || !Number.isSafeInteger(item.retiredAt) || item.retiredAt < 0) throw new Error();
        return { node: parseNode(item.node), retiredAt: item.retiredAt };
      });
      if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length || new Set(nodes.map(node => node.worktreePath)).size !== nodes.length) throw new Error();
      if (new Set(destroys.map(intent => intent.node.nodeId)).size !== destroys.length
        || destroys.some(intent => !nodes.some(node => node.nodeId === intent.node.nodeId && node.containerId === intent.node.containerId))) throw new Error();
      const activeKeys = new Set(nodes.map(node => this.execRuntimeKey(node))); const retiredKeys = retired.map(item => this.execRuntimeKey(item.node));
      if (new Set(retiredKeys).size !== retiredKeys.length || retiredKeys.some(key => activeKeys.has(key))) throw new Error();
      return { version: 3, nodes, destroys, retired };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 3, nodes: [], destroys: [], retired: [] };
      throw new NodeProviderError('DOCKER_WORKTREE_STATE_INVALID', `Docker worktree provider \`${this.id}\` state is invalid.`);
    }
  }

  private async writeState(state: ProviderState): Promise<void> {
    await fs.ensureDir(this.stateDir);
    const temp = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await nativeFs.open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
      await nativeFs.rename(temp, this.statePath); await nativeFs.chmod(this.statePath, 0o600);
      const directory = await nativeFs.open(this.stateDir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await nativeFs.rm(temp, { force: true }).catch(() => {});
    }
  }

  private execRuntimeKey(node: ProviderNodeState): string { return `${node.nodeId}:${node.generation}`; }

  async initialize(): Promise<void> {
    if (this.shutdownStarted) throw new NodeProviderError('DOCKER_WORKTREE_PROVIDER_SHUT_DOWN', `Docker provider \`${this.id}\` is shut down.`);
    if (this.initialized) return;
    if (!this.initializationPromise) this.initializationPromise = this.initializeOnce().finally(() => { this.initializationPromise = undefined; });
    await this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    const state = await this.readState(); const generations = new Map<string, ProviderNodeState>();
    for (const node of [...state.nodes, ...state.destroys.map(item => item.node), ...state.retired.map(item => item.node)]) generations.set(this.execRuntimeKey(node), node);
    await Promise.all([...generations.values()].map(node => this.getExecRuntime(node)));
    await this.mutate(undefined, async (): Promise<void> => {});
    await this.cleanupRetiredGenerations();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return; this.shutdownStarted = true;
    if (this.initializationPromise) await this.initializationPromise.catch(() => {});
    await this.stateMutation;
    const runtimes = [...this.execRuntimes.values()];
    await Promise.allSettled(runtimes.map(async runtime => (await runtime).shutdown()));
    this.execRuntimes.clear(); this.initialized = false;
  }

  private getExecRuntime(node: ProviderNodeState): Promise<ExecRuntime> {
    const key = this.execRuntimeKey(node); const existing = this.execRuntimes.get(key); if (existing) return existing;
    const initializing = (async () => {
      const artifactStat = await fs.lstat(node.artifactDir); const artifactReal = await fs.realpath(node.artifactDir);
      if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink() || artifactReal !== node.artifactDir) throw new NodeProviderError('DOCKER_WORKTREE_ARTIFACT_IDENTITY_INVALID', `Docker Node \`${node.nodeId}\` execution artifact directory is not its exact retained generation directory.`);
      const runtime = createExecRuntime({
        getDefaultCwd: () => node.worktreePath,
        getExecTempDir: () => node.artifactDir,
        registryPath: path.join(node.artifactDir, 'running-exec.json'),
        nodeId: node.nodeId,
        processOperations: this.createDockerProcessOperations(node),
        isEntryRunning: entry => this.isManagedContainerEntryRunning(node, entry.scriptPath),
        readEntryWorkingDirectory: entry => this.readManagedContainerEntryCwd(node, entry.scriptPath),
        onRegistryIdle: () => this.scheduleRetiredCleanup(node),
        processTreeFormatter: (_entries, rootPid) => `Process tree (best-effort Docker boundary; launcher PID ${rootPid}):\n(Container process tree is not represented as host descendants.)`,
        completionDispatcher: async (entry, _status, message) => {
          if (entry.sessionId) await this.queueSystemEvent(entry.sessionId, message);
        },
      });
      await runtime.initialize(); return runtime;
    })();
    this.execRuntimes.set(key, initializing); return initializing;
  }

  private createDockerProcessOperations(node: ProviderNodeState): ProcessOperations {
    const fixedEnvironmentNames = ['TERM', 'FOXWARM_EXEC_LOG_DIR', 'FOXWARM_EXEC_TIME_TOKEN', 'FOXWARM_EXEC_PATHS_PATH', 'FOXWARM_EXEC_NODE_PATH', 'FOXWARM_EXEC_COMMAND_PATH'] as const;
    return {
      platform: 'linux',
      nodePath: '/usr/local/bin/node',
      launch: async (request: ProcessLaunchRequest) => {
        if (request.command !== '/bin/bash' || request.args.length !== 1) throw new Error('Docker exec manager accepts only its exact generated Bash script.');
        let cwd: string; let script: string;
        try { cwd = await fs.realpath(request.cwd); script = await fs.realpath(request.args[0]); }
        catch { throw new Error('Docker exec cwd/script escaped the exact Node roots.'); }
        if (!inside(node.worktreePath, cwd) || !inside(node.artifactDir, script)) throw new Error('Docker exec cwd/script escaped the exact Node roots.');
        const dockerArgs = [...this.config.args, 'exec'];
        for (const name of fixedEnvironmentNames) {
          const value = request.env[name]; if (value === undefined) continue;
          if (name.startsWith('FOXWARM_EXEC_') && name !== 'FOXWARM_EXEC_TIME_TOKEN' && name !== 'FOXWARM_EXEC_NODE_PATH'
            && !inside(node.artifactDir, path.resolve(value))) throw new Error(`Docker exec managed path ${name} escaped its artifact directory.`);
          if (name === 'FOXWARM_EXEC_NODE_PATH' && value !== '/usr/local/bin/node') throw new Error('Docker exec Node path mismatch.');
          dockerArgs.push('-e', `${name}=${value}`);
        }
        dockerArgs.push('-w', cwd, node.containerId, '/bin/bash', script);
        const child = this.launchProcess(this.config.command, dockerArgs, { shell: false, windowsHide: true, stdio: 'ignore', detached: request.detached,
          env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.on('error', () => {}); child.unref();
        if (!child.pid) throw new Error('Docker exec launcher did not expose a direct child PID.');
        return { pid: child.pid };
      },
      isRunning(pid: number) { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } },
      async readWorkingDirectory() { return null; },
      async inspectSnapshot() { return []; },
    };
  }

  private async managedContainerLineage(node: ProviderNodeState, scriptPath: string | undefined): Promise<number[]> {
    if (!scriptPath) return [];
    let script: string; try { script = await fs.realpath(scriptPath); } catch { return []; }
    if (!inside(node.artifactDir, script)) return [];
    let output: DockerResult;
    try { output = await this.docker.run(['top', node.containerId, '-eo', 'pid,ppid,args'], { timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 }); }
    catch (error) {
      const listed = await this.docker.run(['ps', '--no-trunc', '--filter', `id=${node.containerId}`, '--format', '{{.ID}}'], { timeoutMs: 2_000, maxOutputBytes: 64 * 1024 });
      const runningIds = listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (runningIds.length === 0) return [];
      if (!runningIds.includes(node.containerId)) throw new NodeProviderError('DOCKER_WORKTREE_CONTAINER_MISMATCH', `Docker runtime liveness for Node \`${node.nodeId}\` did not resolve the exact container.`);
      throw error;
    }
    try {
      const rows = output.stdout.split(/\r?\n/).map(value => { const match = value.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/); return match ? { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] } : null; }).filter((value): value is { pid: number; ppid: number; args: string } => !!value);
      const root = rows.find(value => value.args.includes(script)); if (!root) return []; const descendants = [root.pid];
      for (let index = 0; index < descendants.length; index++) for (const row of rows) if (row.ppid === descendants[index] && !descendants.includes(row.pid)) descendants.push(row.pid);
      return descendants;
    } catch { return []; }
  }

  private async isManagedContainerEntryRunning(node: ProviderNodeState, scriptPath: string | undefined): Promise<boolean> {
    return (await this.managedContainerLineage(node, scriptPath)).length > 0;
  }

  private async readManagedContainerEntryCwd(node: ProviderNodeState, scriptPath: string | undefined): Promise<string | null> {
    const lineage = await this.managedContainerLineage(node, scriptPath);
    for (const candidate of lineage.reverse()) {
      try { const cwd = (await nativeFs.readlink(`/proc/${candidate}/cwd`)).trim(); const canonical = await fs.realpath(cwd); if (inside(node.worktreePath, canonical)) return canonical; } catch {}
    }
    return null;
  }

  private async cleanupRetiredGenerations(): Promise<void> {
    if (this.shutdownStarted) return;
    await this.mutate(undefined, async state => {
      for (const retired of [...state.retired]) {
        const key = this.execRuntimeKey(retired.node); const runtimePromise = this.execRuntimes.get(key) || this.getExecRuntime(retired.node); const runtime = await runtimePromise;
        await runtime.reconcileNow();
        if (runtime.listRunningExecs().length === 0) {
          await runtime.shutdown(); this.execRuntimes.delete(key); state.retired = state.retired.filter(item => this.execRuntimeKey(item.node) !== key);
        }
      }
    });
  }

  private scheduleRetiredCleanup(node: ProviderNodeState): void {
    const key = this.execRuntimeKey(node);
    const timer = setTimeout(() => {
      if (this.shutdownStarted) return;
      void this.readState().then(state => {
        if (state.retired.some(item => this.execRuntimeKey(item.node) === key)) return this.cleanupRetiredGenerations();
      }).catch(error => logger.warn({ err: error, providerId: this.id }, 'Failed to clean retired Docker exec generation'));
    }, 0);
    timer.unref?.();
  }

  private async mutate<T>(options: NodeProviderCallOptions | undefined, effect: (state: ProviderState) => Promise<T>): Promise<T> {
    const previous = this.stateMutation; let release!: () => void; this.stateMutation = new Promise(resolve => { release = resolve; }); await previous;
    try {
      if (options?.signal?.aborted) throw new NodeProviderError('DOCKER_WORKTREE_CANCELLED', 'Docker worktree operation was cancelled before provider effect.', true);
      const state = await this.readState(); await this.recoverDestroyIntents(state, options); const originalIds = new Set(state.nodes.map(node => node.containerId));
      const result = await effect(state);
      try { await this.writeState(state); }
      catch {
        for (const node of state.nodes.filter(item => !originalIds.has(item.containerId))) await this.docker.run(['rm', '--force', node.containerId], { timeoutMs: 30_000 }).catch(() => {});
        throw new NodeProviderError('DOCKER_WORKTREE_STATE_WRITE_FAILED', `Docker worktree provider \`${this.id}\` could not persist authoritative state.`);
      }
      return result;
    } finally { release(); }
  }

  private descriptor(node: ProviderNodeState, availability: NodeDescriptor['availability'] = 'ready'): NodeDescriptor {
    return { id: node.nodeId, kind: 'sandbox', provider: this.id, type: 'docker-worktree', availability, defaultCwd: node.worktreePath, tools: TOOL_DESCRIPTORS as any };
  }

  private containerName(nodeId: string, configHash = this.configHash): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify([this.id, nodeId, configHash])).digest('hex').slice(0, 24);
    return `foxwarm-${safeId(this.id).slice(0, 12)}-${safeId(nodeId).slice(0, 12)}-${digest}`;
  }

  private assertCurrentConfig(node: ProviderNodeState): void {
    if (node.configHash !== this.configHash) throw new NodeProviderError('DOCKER_WORKTREE_STALE_CONFIG', `Docker Node \`${node.nodeId}\` was created under stale provider configuration.`, false);
  }

  private async inspectContainer(node: ProviderNodeState, options?: NodeProviderCallOptions): Promise<any> {
    let output: DockerResult;
    try { output = await this.docker.run(['inspect', node.containerId], { maxOutputBytes: 1024 * 1024, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_CONTAINER_UNAVAILABLE', options?.signal?.aborted ? `Docker inspection for Node \`${node.nodeId}\` was cancelled.` : `Docker container for Node \`${node.nodeId}\` is unavailable.`, true); }
    let inspected: any;
    try { inspected = JSON.parse(output.stdout)?.[0]; } catch { throw new NodeProviderError('DOCKER_WORKTREE_INSPECT_INVALID', `Docker returned invalid inspect data for Node \`${node.nodeId}\`.`); }
    const labels = inspected?.Config?.Labels || {};
    const mounts = Array.isArray(inspected?.Mounts) ? inspected.Mounts : [];
    const artifactMount = mounts.filter((mount: any) => mount?.Source === node.artifactDir && mount?.Destination === node.artifactDir && mount?.RW === true);
    if (typeof inspected?.Id !== 'string' || !inspected.Id.startsWith(node.containerId)
      || labels['foxwarm.provider'] !== this.id || labels['foxwarm.node'] !== node.nodeId || labels['foxwarm.worktree'] !== node.worktreePath
      || labels['foxwarm.configHash'] !== node.configHash
      || inspected?.Name !== `/${node.containerName}` || inspected?.Config?.Image !== node.image
      || inspected?.HostConfig?.NetworkMode !== node.networkMode || inspected?.Config?.User !== `${node.uid}:${node.gid}` || artifactMount.length !== 1) {
      throw new NodeProviderError('DOCKER_WORKTREE_CONTAINER_MISMATCH', `Docker container identity for Node \`${node.nodeId}\` does not match provider state.`);
    }
    return inspected;
  }

  private async exactContainerPresent(node: ProviderNodeState, options?: NodeProviderCallOptions): Promise<boolean> {
    let listed: DockerResult;
    try { listed = await this.docker.run(['ps', '-a', '--filter', `name=^/${node.containerName}$`, '--format', '{{.ID}}'], { maxOutputBytes: 64 * 1024, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_DESTROY_RECOVERY_FAILED', options?.signal?.aborted ? `Destroy recovery for Node \`${node.nodeId}\` was cancelled.` : `Docker could not reconcile pending destroy for Node \`${node.nodeId}\`.`, true); }
    const ids = listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (ids.length === 0) return false;
    if (ids.length !== 1 || !(node.containerId.startsWith(ids[0]) || ids[0].startsWith(node.containerId))) throw new NodeProviderError('DOCKER_WORKTREE_CONTAINER_MISMATCH', `Pending destroy identity for Node \`${node.nodeId}\` does not match Docker.`);
    await this.inspectContainer(node, options);
    return true;
  }

  private async recoverDestroyIntents(state: ProviderState, options?: NodeProviderCallOptions): Promise<string[]> {
    const completed: string[] = [];
    for (const intent of [...state.destroys]) {
      if (await this.exactContainerPresent(intent.node, options)) {
        await this.docker.run(['rm', '--force', intent.node.containerId], { timeoutMs: 30_000, signal: options?.signal });
      }
      await this.retainGenerationIfBusy(state, intent.node);
      state.nodes = state.nodes.filter(node => node.nodeId !== intent.node.nodeId);
      state.destroys = state.destroys.filter(item => item.node.nodeId !== intent.node.nodeId);
      completed.push(intent.node.nodeId);
    }
    if (completed.length > 0) await this.writeState(state);
    return completed;
  }

  private async retainGenerationIfBusy(state: ProviderState, node: ProviderNodeState): Promise<void> {
    const key = this.execRuntimeKey(node); const runtime = await this.getExecRuntime(node); await runtime.reconcileNow();
    if (runtime.listRunningExecs().length > 0) {
      if (!state.retired.some(item => this.execRuntimeKey(item.node) === key)) {
        if (state.retired.length >= 200) throw new NodeProviderError('DOCKER_WORKTREE_RETIRED_LIMIT', 'Docker provider retained-generation limit is reached; pending completions must be delivered before another destroy can finalize.');
        state.retired.push({ node: { ...node }, retiredAt: Date.now() });
      }
      return;
    }
    await runtime.shutdown(); this.execRuntimes.delete(key);
  }

  private async cleanupExactOrphan(nodeId: string, worktreePath: string, networkMode: 'none' | 'bridge', options?: NodeProviderCallOptions): Promise<boolean> {
    const name = this.containerName(nodeId);
    let listed: DockerResult;
    try { listed = await this.docker.run(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { maxOutputBytes: 64 * 1024, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_ORPHAN_RECONCILE_FAILED', options?.signal?.aborted ? `Docker orphan reconciliation for Node \`${nodeId}\` was cancelled.` : `Docker could not reconcile the exact runtime name for Node \`${nodeId}\`.`, true); }
    const ids = listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (ids.length === 0) return false;
    if (ids.length !== 1) throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker container name \`${name}\` did not resolve uniquely.`);
    let output: DockerResult;
    try { output = await this.docker.run(['inspect', ids[0]], { maxOutputBytes: 1024 * 1024, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_ORPHAN_RECONCILE_FAILED', options?.signal?.aborted ? `Docker orphan inspection for Node \`${nodeId}\` was cancelled.` : `Docker could not inspect the exact runtime for Node \`${nodeId}\`.`, true); }
    let inspected: any; try { inspected = JSON.parse(output.stdout)?.[0]; } catch { throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker container name \`${name}\` returned invalid identity data.`); }
    const labels = inspected?.Config?.Labels || {};
    const exact = inspected?.Name === `/${name}` && labels['foxwarm.provider'] === this.id && labels['foxwarm.node'] === nodeId
      && labels['foxwarm.worktree'] === worktreePath && labels['foxwarm.configHash'] === this.configHash
      && inspected?.Config?.Image === this.config.image && inspected?.HostConfig?.NetworkMode === networkMode
      && inspected?.Config?.User === `${this.runtimeUid}:${this.runtimeGid}`;
    if (!exact) throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker container name \`${name}\` is occupied by an uncorroborated runtime.`);
    await this.docker.run(['rm', '--force', inspected.Id], { timeoutMs: 30_000 });
    return true;
  }

  private async cleanupCrashGapOrphans(state: ProviderState, options?: NodeProviderCallOptions): Promise<void> {
    let listed: DockerResult;
    try { listed = await this.docker.run(['ps', '-a', '--filter', `label=foxwarm.provider=${this.id}`, '--format', '{{.ID}}'], { maxOutputBytes: 64 * 1024, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_ORPHAN_RECONCILE_FAILED', options?.signal?.aborted ? 'Docker crash-gap reconciliation was cancelled.' : `Docker provider \`${this.id}\` could not reconcile crash-gap runtimes.`, true); }
    const owned = new Set(state.nodes.map(node => node.containerId));
    for (const id of listed.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      if ([...owned].some(value => value.startsWith(id) || id.startsWith(value))) continue;
      let output: DockerResult; try { output = await this.docker.run(['inspect', id], { maxOutputBytes: 1024 * 1024, signal: options?.signal }); } catch { continue; }
      let inspected: any; try { inspected = JSON.parse(output.stdout)?.[0]; } catch { continue; }
      const labels = inspected?.Config?.Labels || {}; const nodeId = labels['foxwarm.node']; const worktreePath = labels['foxwarm.worktree'];
      if (labels['foxwarm.provider'] !== this.id) continue;
      if (labels['foxwarm.configHash'] !== this.configHash) throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker provider \`${this.id}\` found a runtime owned by a different state/config identity.`);
      if (typeof nodeId !== 'string' || typeof worktreePath !== 'string') throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker provider \`${this.id}\` found an uncorroborated labeled runtime.`);
      const expectedName = this.containerName(nodeId);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(nodeId) || !this.allowedRoots.some(root => inside(root, worktreePath))
        || inspected?.Name !== `/${expectedName}` || inspected?.Config?.Image !== this.config.image
        || inspected?.Config?.User !== `${this.runtimeUid}:${this.runtimeGid}` || !this.config.networkModes.includes(inspected?.HostConfig?.NetworkMode)) {
        throw new NodeProviderError('DOCKER_WORKTREE_ORPHAN_MISMATCH', `Docker provider \`${this.id}\` found an uncorroborated crash-gap runtime.`);
      }
      await this.docker.run(['rm', '--force', inspected.Id], { timeoutMs: 30_000 });
    }
  }

  async listNodes(options?: NodeProviderCallOptions): Promise<NodeDescriptor[]> {
    return this.mutate(options, async state => {
      await this.cleanupCrashGapOrphans(state, options); const nodes: NodeDescriptor[] = [];
      for (const node of state.nodes) {
        if (node.configHash !== this.configHash) { nodes.push(this.descriptor(node, 'error')); continue; }
        try { const inspected = await this.inspectContainer(node, options); nodes.push(this.descriptor(node, inspected?.State?.Running === true ? 'ready' : 'offline')); } catch { nodes.push(this.descriptor(node, 'error')); }
      }
      return nodes;
    });
  }
  async getNode(nodeId: string, options?: NodeProviderCallOptions): Promise<NodeDescriptor | undefined> { return (await this.listNodes(options)).find(node => node.id === nodeId); }
  async getDefaultCwd(request: NodeDefaultCwdRequest): Promise<string | undefined> { const state = await this.readState(); const node = state.nodes.find(item => item.nodeId === request.nodeId); if (node) { if (state.destroys.some(intent => intent.node.nodeId === node.nodeId)) throw new NodeProviderError('DOCKER_WORKTREE_DESTROY_PENDING', `Docker Node \`${node.nodeId}\` has a committed destroy pending.`); this.assertCurrentConfig(node); } return node?.worktreePath; }

  private async gitIdentity(worktreeInput: string): Promise<{ worktreePath: string; gitMarkerPath: string; gitMarkerType: 'file' | 'directory'; gitDir: string; gitCommonDir: string }> {
    if (process.platform !== 'linux') throw new NodeProviderError('DOCKER_WORKTREE_UNSUPPORTED_PLATFORM', 'Docker worktree providers currently require Linux.');
    let worktreePath: string;
    try { worktreePath = await fs.realpath(path.resolve(worktreeInput)); } catch { throw new NodeProviderError('DOCKER_WORKTREE_NOT_FOUND', 'Configured worktree path does not exist.'); }
    if (!this.allowedRoots.some(root => inside(root, worktreePath))) throw new NodeProviderError('DOCKER_WORKTREE_PATH_DENIED', 'Worktree path is outside configured allowed roots.');
    const gitMarkerPath = path.join(worktreePath, '.git'); let markerStats;
    try { markerStats = await fs.lstat(gitMarkerPath); } catch { throw new NodeProviderError('DOCKER_WORKTREE_GIT_INVALID', 'Worktree must have an exact .git file or directory marker.'); }
    if (markerStats.isSymbolicLink() || (!markerStats.isFile() && !markerStats.isDirectory())) throw new NodeProviderError('DOCKER_WORKTREE_GIT_INVALID', 'Worktree .git marker must be a regular file or directory, not a symlink or special file.');
    const gitMarkerType = markerStats.isFile() ? 'file' as const : 'directory' as const;
    try {
      let gitDir: string; let gitCommonDir: string;
      if (gitMarkerType === 'directory') {
        gitDir = await fs.realpath(gitMarkerPath); gitCommonDir = gitDir;
      } else {
        const marker = await fs.readFile(gitMarkerPath, 'utf8'); const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(marker);
        if (!match) throw new Error();
        gitDir = await fs.realpath(path.resolve(worktreePath, match[1]));
        const commonText = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8');
        gitCommonDir = await fs.realpath(path.resolve(gitDir, commonText.trim()));
        const backlink = (await fs.readFile(path.join(gitDir, 'gitdir'), 'utf8')).trim();
        if (await fs.realpath(path.resolve(gitDir, backlink)) !== await fs.realpath(gitMarkerPath)) throw new Error();
        if (path.dirname(path.dirname(gitDir)) !== gitCommonDir || path.basename(path.dirname(gitDir)) !== 'worktrees') throw new Error();
      }
      for (const mount of [worktreePath, gitMarkerPath, gitDir, gitCommonDir]) assertDockerMountPath(mount);
      const listed = await this.runSanitizedGit(gitCommonDir, gitCommonDir, worktreePath, ['worktree', 'list', '--porcelain']);
      const registered = listed.split(/\r?\n\r?\n/).some(block => block.split(/\r?\n/)[0] === `worktree ${worktreePath}`);
      if (!registered) throw new Error();
      return { worktreePath, gitMarkerPath, gitMarkerType, gitDir, gitCommonDir };
    } catch (error) { if (error instanceof NodeProviderError) throw error; throw new NodeProviderError('DOCKER_WORKTREE_GIT_INVALID', 'Path must be an exact existing Git worktree or checkout.'); }
  }

  private async gitHeadBranch(evidence: Awaited<ReturnType<DockerWorktreeNodeProvider['gitIdentity']>>): Promise<{ head: string; branch: string }> {
    const git = async (args: string[]) => (await this.runSanitizedGit(evidence.gitDir, evidence.gitCommonDir, evidence.worktreePath, args)).trim();
    return { head: await git(['rev-parse', 'HEAD']), branch: (await git(['symbolic-ref', '--short', '-q', 'HEAD'])) || '(detached)' };
  }

  private async runSanitizedGit(gitDir: string, gitCommonDir: string, worktreePath: string, args: string[]): Promise<string> {
    const env = { PATH: process.env.PATH || '', GIT_DIR: gitDir, GIT_COMMON_DIR: gitCommonDir, GIT_WORK_TREE: worktreePath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '' };
    const fixed = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'submodule.recurse=false', '-c', 'status.submoduleSummary=false'];
    return (await execFileAsync('git', [...fixed, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env })).stdout;
  }

  private assertGitIdentity(node: ProviderNodeState, evidence: Awaited<ReturnType<DockerWorktreeNodeProvider['gitIdentity']>>): void {
    if (node.worktreePath !== evidence.worktreePath || node.gitMarkerPath !== evidence.gitMarkerPath || node.gitMarkerType !== evidence.gitMarkerType
      || node.gitDir !== evidence.gitDir || node.gitCommonDir !== evidence.gitCommonDir) throw new NodeProviderError('DOCKER_WORKTREE_GIT_MISMATCH', `Git identity for Node \`${node.nodeId}\` no longer matches authoritative provider state.`);
  }

  private assertStateIsolation(evidence: Awaited<ReturnType<DockerWorktreeNodeProvider['gitIdentity']>>): void {
    for (const target of [evidence.worktreePath, evidence.gitMarkerPath, evidence.gitDir, evidence.gitCommonDir]) {
      if (inside(target, this.stateDir) || inside(this.stateDir, target)) throw new NodeProviderError('DOCKER_WORKTREE_STATE_OVERLAP', 'Provider state must not overlap the worktree or Git administration paths.');
    }
  }

  private lifecycleParams(request: NodeLifecycleProviderRequest): { nodeId: string; worktreePath: string; networkMode: 'none' | 'bridge' } {
    onlyKeys(request.parameters, ['worktreePath', 'networkMode']);
    if (!request.nodeId) throw new NodeProviderError('DOCKER_WORKTREE_NODE_ID_REQUIRED', 'Docker worktree create/ensure requires an exact nodeId.');
    const worktreePath = request.parameters.worktreePath; const networkMode = request.parameters.networkMode ?? 'none';
    if (typeof worktreePath !== 'string' || !worktreePath.trim()) throw new NodeProviderError('DOCKER_WORKTREE_PATH_REQUIRED', 'parameters.worktreePath is required.');
    if ((networkMode !== 'none' && networkMode !== 'bridge') || !this.config.networkModes.includes(networkMode)) throw new NodeProviderError('DOCKER_WORKTREE_NETWORK_DENIED', 'Requested networkMode is not configured for this provider.');
    return { nodeId: request.nodeId, worktreePath, networkMode };
  }

  private async startContainer(
    nodeId: string,
    evidence: Awaited<ReturnType<DockerWorktreeNodeProvider['gitIdentity']>> & Awaited<ReturnType<DockerWorktreeNodeProvider['gitHeadBranch']>>,
    networkMode: 'none' | 'bridge',
    options?: NodeProviderCallOptions,
  ): Promise<ProviderNodeState> {
    const containerName = this.containerName(nodeId);
    await this.cleanupExactOrphan(nodeId, evidence.worktreePath, networkMode, options);
    const generation = crypto.randomBytes(16).toString('hex');
    const artifactDir = path.join(this.stateDir, 'exec-artifacts', safeId(nodeId), generation);
    assertDockerMountPath(artifactDir); await fs.ensureDir(artifactDir); await fs.chmod(artifactDir, 0o700);
    const mounts = Array.from(new Set([evidence.worktreePath, evidence.gitMarkerPath, evidence.gitCommonDir, evidence.gitDir]));
    const args = ['run', '--detach', '--init', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${this.runtimeUid}:${this.runtimeGid}`,
      '--network', networkMode, '--pids-limit', String(this.config.pidsLimit), '--memory', this.config.memory, '--cpus', String(this.config.cpus), '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${this.config.tmpfsSize}`,
      '--name', containerName, '--label', `foxwarm.provider=${this.id}`, '--label', `foxwarm.node=${nodeId}`, '--label', `foxwarm.worktree=${evidence.worktreePath}`, '--label', `foxwarm.configHash=${this.configHash}`];
    for (const mount of mounts) args.push('--mount', `type=bind,src=${mount},dst=${mount}${mount === evidence.worktreePath ? '' : ',readonly'}`);
    args.push('--mount', `type=bind,src=${artifactDir},dst=${artifactDir}`);
    args.push('-e', `FOXWARM_WORKTREE_ROOT=${evidence.worktreePath}`, '-w', evidence.worktreePath, this.config.image, 'tail', '-f', '/dev/null');
    let output: DockerResult;
    try { output = await this.docker.run(args, { timeoutMs: 120_000, signal: options?.signal }); }
    catch (error) {
      try { await this.cleanupExactOrphan(nodeId, evidence.worktreePath, networkMode); }
      catch (cleanupError) { throw cleanupError; }
      throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_START_FAILED', options?.signal?.aborted ? `Docker start for Node \`${nodeId}\` was cancelled.` : `Docker failed to start Node \`${nodeId}\`.`, true);
    }
    const containerId = output.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) {
      await this.cleanupExactOrphan(nodeId, evidence.worktreePath, networkMode);
      throw new NodeProviderError('DOCKER_WORKTREE_START_INVALID', 'Docker returned an invalid container identity.');
    }
    const node = { nodeId, worktreePath: evidence.worktreePath, gitMarkerPath: evidence.gitMarkerPath, gitMarkerType: evidence.gitMarkerType,
      gitDir: evidence.gitDir, gitCommonDir: evidence.gitCommonDir, image: this.config.image, networkMode, containerId, containerName,
      configHash: this.configHash, generation, artifactDir, createdAt: Date.now(), uid: this.runtimeUid, gid: this.runtimeGid };
    try { await this.inspectContainer(node, options); }
    catch (error) { await this.docker.run(['rm', '--force', containerId], { timeoutMs: 30_000 }).catch(() => {}); throw error; }
    return node;
  }

  private async createOrEnsure(request: NodeLifecycleProviderRequest, ensure: boolean, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    if (options?.signal?.aborted) throw new NodeProviderError('DOCKER_WORKTREE_CANCELLED', 'Docker worktree operation was cancelled before provider effect.', true);
    const params = this.lifecycleParams(request); const identity = await this.gitIdentity(params.worktreePath); this.assertStateIsolation(identity);
    const result = await this.mutate(options, async state => {
      const existing = state.nodes.find(node => node.nodeId === params.nodeId);
      const owner = state.nodes.find(node => node.worktreePath === identity.worktreePath && node.nodeId !== params.nodeId);
      if (owner) throw new NodeProviderError('DOCKER_WORKTREE_ALREADY_ASSIGNED', 'Worktree is already assigned to another Docker Node.');
      if (existing) {
        if (!ensure) throw new NodeProviderError('DOCKER_WORKTREE_NODE_EXISTS', `Node \`${params.nodeId}\` already exists.`);
        this.assertCurrentConfig(existing); this.assertGitIdentity(existing, identity);
        if (existing.image !== this.config.image || existing.networkMode !== params.networkMode) throw new NodeProviderError('DOCKER_WORKTREE_ENSURE_MISMATCH', 'Existing Docker Node immutable configuration does not match ensure parameters.');
        await this.inspectContainer(existing, options);
        const evidence = { ...identity, ...await this.gitHeadBranch(identity) };
        return this.lifecycleResult(existing, evidence, 'Docker container and exact worktree registration already exist.');
      }
      await this.cleanupCrashGapOrphans(state, options);
      const evidence = { ...identity, ...await this.gitHeadBranch(identity) };
      const node = await this.startContainer(params.nodeId, evidence, params.networkMode, options); state.nodes.push(node);
      return this.lifecycleResult(node, evidence, 'Started a provider-owned Docker container for the existing worktree.');
    });
    const persisted = (await this.readState()).nodes.find(node => node.nodeId === params.nodeId); if (persisted) await this.getExecRuntime(persisted);
    return result;
  }

  private lifecycleResult(node: ProviderNodeState, evidence: Awaited<ReturnType<DockerWorktreeNodeProvider['gitIdentity']>> & Awaited<ReturnType<DockerWorktreeNodeProvider['gitHeadBranch']>>, effect: string): NodeLifecycleResult {
    return { node: this.descriptor(node), effect, dataRetention: 'The existing worktree, Git metadata, and exact generation execution artifacts are retained. Git metadata is mounted read-only; this Node can inspect but cannot commit.', details: { worktreePath: node.worktreePath, artifactDir: node.artifactDir, generation: node.generation, head: evidence.head, branch: evidence.branch, containerId: node.containerId, image: node.image, networkMode: node.networkMode, status: 'running', containment: 'Docker filesystem and process isolation with only the configured worktree, exact generation artifact directory, and read-only Git metadata mounted; not VM-grade isolation.', limitations: ['Process-tree and live-cwd inspection are limited at the Docker launcher boundary.', 'Git refs and objects are read-only.', 'No browser, PTY, Code, copy, or fixed services.'] } };
  }

  createNode(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> { return this.createOrEnsure(request, false, options); }
  ensureNode(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> { return this.createOrEnsure(request, true, options); }
  async inspectNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    onlyKeys(request.parameters, []); const node = (await this.readState()).nodes.find(item => item.nodeId === request.nodeId);
    if (!node) throw new NodeProviderError('DOCKER_WORKTREE_NODE_NOT_FOUND', `Node \`${request.nodeId}\` was not found.`);
    const inspected = await this.inspectContainer(node, options);
    if (node.configHash !== this.configHash) return { node: this.descriptor(node, 'error'), effect: 'Inspected the exactly corroborated runtime without executing capabilities.', dataRetention: 'Destroy remains available and retains worktree/Git/provider data.', details: { status: 'stale-config', worktreePath: node.worktreePath, containerId: node.containerId, storedConfigHash: node.configHash, currentConfigHash: this.configHash, limitation: 'Provider configuration changed; capabilities and Git evidence are unavailable until the stale runtime is destroyed and recreated.' } };
    const identity = await this.gitIdentity(node.worktreePath); this.assertStateIsolation(identity); this.assertGitIdentity(node, identity);
    const evidence = { ...identity, ...await this.gitHeadBranch(identity) };
    const result = this.lifecycleResult(node, evidence, 'Inspected provider state, Docker identity, and the existing worktree without mutation.');
    (result.details as any).status = inspected?.State?.Running === true ? 'running' : String(inspected?.State?.Status || 'unknown'); return result;
  }
  async destroyNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    onlyKeys(request.parameters, []);
    const previous = this.stateMutation; let release!: () => void; this.stateMutation = new Promise(resolve => { release = resolve; }); await previous;
    try {
      if (options?.signal?.aborted) throw new NodeProviderError('DOCKER_WORKTREE_CANCELLED', 'Docker destroy was cancelled before provider effect.', true);
      const state = await this.readState(); const priorIntent = state.destroys.find(intent => intent.node.nodeId === request.nodeId);
      const completed = await this.recoverDestroyIntents(state, options);
      if (completed.includes(request.nodeId) && priorIntent) return this.destroyResult(priorIntent.node, 'Completed the previously committed provider destroy intent.');
      const node = state.nodes.find(item => item.nodeId === request.nodeId);
      if (!node) throw new NodeProviderError('DOCKER_WORKTREE_NODE_NOT_FOUND', `Node \`${request.nodeId}\` was not found.`);
      await this.inspectContainer(node, options);
      state.destroys.push({ node: { ...node }, requestedAt: Date.now() });
      try { await this.writeState(state); }
      catch { throw new NodeProviderError('DOCKER_WORKTREE_STATE_WRITE_FAILED', `Docker worktree provider \`${this.id}\` could not durably commit destroy intent.`); }
      try {
        if (await this.exactContainerPresent(node, options)) await this.docker.run(['rm', '--force', node.containerId], { timeoutMs: 30_000, signal: options?.signal });
      } catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_DESTROY_FAILED', options?.signal?.aborted ? `Docker destroy for Node \`${request.nodeId}\` was cancelled after intent commit.` : `Docker failed to complete committed destroy for Node \`${request.nodeId}\`.`, true); }
      await this.retainGenerationIfBusy(state, node);
      state.nodes = state.nodes.filter(item => item.nodeId !== node.nodeId); state.destroys = state.destroys.filter(intent => intent.node.nodeId !== node.nodeId);
      try { await this.writeState(state); }
      catch { throw new NodeProviderError('DOCKER_WORKTREE_STATE_WRITE_FAILED', `Docker worktree provider \`${this.id}\` could not finalize committed destroy state.`); }
      return this.destroyResult(node, 'Stopped and removed only the provider-owned Docker container and registration.');
    } finally { release(); }
  }

  private destroyResult(node: ProviderNodeState, effect: string): NodeLifecycleResult {
    return { nodeId: node.nodeId, effect, dataRetention: 'The existing worktree bytes and changes, Git metadata, and exact generation execution artifacts are retained.', details: { worktreePath: node.worktreePath, artifactDir: node.artifactDir, retained: ['worktree bytes', 'Git metadata', 'generation execution registry, scripts, status, cwd, and logs'] } };
  }

  async invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown> {
    if (!TOOLS.has(request.toolName)) throw new NodeProviderError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`);
    if (options?.signal?.aborted) throw new NodeProviderError('DOCKER_WORKTREE_CANCELLED', 'Docker worktree capability was cancelled before provider effect.', true);
    const state = await this.readState(); const node = state.nodes.find(item => item.nodeId === request.nodeId); if (!node) throw new NodeProviderError('DOCKER_WORKTREE_NODE_NOT_FOUND', `Node \`${request.nodeId}\` was not found.`);
    if (state.destroys.some(intent => intent.node.nodeId === node.nodeId)) throw new NodeProviderError('DOCKER_WORKTREE_DESTROY_PENDING', `Docker Node \`${node.nodeId}\` has a committed destroy pending.`);
    this.assertCurrentConfig(node);
    const inspected = await this.inspectContainer(node, options); if (inspected?.State?.Running !== true) throw new NodeProviderError('DOCKER_WORKTREE_CONTAINER_UNAVAILABLE', `Docker Node \`${request.nodeId}\` is not running.`, true);
    if ((request.toolName === 'write' || request.toolName === 'edit') && typeof request.args.filePath === 'string' && path.isAbsolute(request.args.filePath)
      && !inside(node.worktreePath, path.resolve(request.args.filePath))) throw new NodeProviderError('DOCKER_WORKTREE_PATH_DENIED', 'Docker worktree mutation path is outside the exact worktree.');
    if (request.toolName === 'exec') {
      const runtime = await this.getExecRuntime(node);
      return await tool_exec(request.args as any, {
        sessionId: request.sourceSessionId,
        session: { id: request.sourceSessionId, agent: request.context.agent, currentNode: request.nodeId, ...(request.context.cwd ? { cwd: request.context.cwd } : {}) },
        runtimeNodeId: request.nodeId,
        execRuntime: runtime,
        detachedReadOnlySession: true,
        skipExecPreSave: true,
        deferSessionCwdSync: request.context.deferSessionCwdSync === true,
        toolExecutionSnapshot: { currentNode: request.nodeId, ...(request.context.cwd ? { cwd: request.context.cwd } : {}) },
      });
    }
    if (request.toolName === 'read' && typeof request.args.filePath === 'string' && path.isAbsolute(request.args.filePath)) {
      let resolved: string | undefined;
      try { resolved = await fs.realpath(request.args.filePath); } catch {}
      if (resolved && inside(node.artifactDir, resolved)) {
        return await readFileToolPath(resolved, request.args.filePath, request.args.startLine as any, request.args.endLine as any);
      }
    }
    const input = JSON.stringify({ toolName: request.toolName, args: request.args, ...(request.context.cwd ? { cwd: request.context.cwd } : {}) });
    if (Buffer.byteLength(input, 'utf8') > MAX_OUTPUT) throw new NodeProviderError('DOCKER_WORKTREE_HELPER_INPUT_TOO_LARGE', 'Docker worktree capability input exceeds the fixed 8 MiB provider limit.');
    let output: DockerResult;
    try { output = await this.docker.run(['exec', '-i', '-e', `FOXWARM_WORKTREE_ROOT=${node.worktreePath}`, node.containerId, 'node', HELPER_PATH], { input, timeoutMs: 90_000, maxOutputBytes: MAX_OUTPUT, signal: options?.signal }); }
    catch { throw new NodeProviderError(options?.signal?.aborted ? 'DOCKER_WORKTREE_CANCELLED' : 'DOCKER_WORKTREE_HELPER_FAILED', options?.signal?.aborted ? `Docker worktree capability \`${request.toolName}\` was cancelled.` : `Docker worktree capability \`${request.toolName}\` failed.`, true); }
    let parsed: any; try { parsed = JSON.parse(output.stdout); } catch { throw new NodeProviderError('DOCKER_WORKTREE_HELPER_INVALID', 'Docker worktree helper returned an invalid response.'); }
    if (parsed?.ok !== true) throw new NodeProviderError('DOCKER_WORKTREE_TOOL_FAILED', typeof parsed?.error === 'string' ? parsed.error.slice(0, 16_384) : 'Docker worktree capability failed.');
    return parsed.result;
  }
}
import { parseUnifiedEdit, applyTextEdits } from './unifiedEdit';
import fs from 'fs-extra';
import type { Dirent } from 'node:fs';
import path from 'path';
import { getNodeAgentDir, resolveNodePath } from './nodeFileTransfer';
import { applyPatchOperations, readFileToolPath, requireToolFilePath, writeFileToolPath } from './fileToolCore';
import {
  nativeFileOperations,
  readWholeFile,
  type FileOperations,
} from './fileOperations';
import { PersistentExecManager, resolveExecTimeoutSeconds, type ExecStatus, type RunningExecEntry } from './persistentExec';
import type { ResolvedToolPath } from './resolvedPathMetadata';
import type { ExternalNodeOwner } from './nodeProtocol';
import { nativeProcessOperations } from './processOperations';

export interface NodeToolContext {
  signal?: AbortSignal;
  sessionId?: string;
  /** Trusted caller context, not a tool argument or permission identity. */
  programmatic?: true;
  session?: { agent?: string; cwd?: string; currentNode?: string };
  externalOwner?: ExternalNodeOwner;
  externalExecManager?: PersistentExecManager;
  externalCwd?: string;
  onExecBackground?: (execId: string) => void;
  onExecForeground?: (execId: string, output: string, cwd: string) => void;
  runtimeNodeId?: string;
  backgroundExecId?: string;
  completionCapability?: string;
  onExecStarted?: () => void;
  registerBackgroundExec?: (metadata: Required<Pick<NodeSessionEventMetadata, 'execId' | 'completionCapability'>>) => Promise<void>;
  fileOperations?: FileOperations;
  /** Resolve a model-visible path in the target Node namespace. */
  resolveFilePath?: (filePath: string) => string;
  /** Return the parent in that same namespace without imposing host path semantics. */
  dirnameFilePath?: (filePath: string) => string | Promise<string>;
  onResolvedPaths?: (paths: ResolvedToolPath[]) => void;
  broadcast?: (text: string) => Promise<void>;
  queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot', metadata?: NodeSessionEventMetadata) => Promise<void>;
}

export type NodeSessionEventMetadata = {
  eventId?: string;
  execId?: string;
  completionCapability?: string;
  eventTimestamp?: number;
};
export type NodeSessionEventDispatcher = (
  sessionId: string,
  message: string,
  type: 'background' | 'trigger' | 'onboot',
  metadata?: NodeSessionEventMetadata,
) => Promise<void>;

type ToolArgs = Record<string, any>;

function resolveToolPath(filePath: string, ctx: NodeToolContext): string {
  return ctx.resolveFilePath?.(filePath) ?? resolveNodePath(filePath, ctx.session?.agent || 'main', ctx.session?.cwd);
}

async function dirnameToolPath(filePath: string, ctx: NodeToolContext): Promise<string> {
  return ctx.dirnameFilePath?.(filePath) ?? path.dirname(filePath);
}

export async function read(args: ToolArgs, ctx: NodeToolContext = {}) {
  const filePath = requireToolFilePath(args.filePath, 'read');
  const { startLine, endLine } = args;
  const fullPath = resolveToolPath(filePath, ctx);
  const result = await readFileToolPath(fullPath, filePath, startLine, endLine, ctx.fileOperations, ctx.programmatic === true);
  ctx.onResolvedPaths?.([{ raw: filePath, resolved: fullPath }]);
  return result;
}

export async function write(args: ToolArgs, ctx: NodeToolContext = {}) {
  const { filePath, content, overwrite } = args;
  if (typeof content !== 'string') throw new Error('write requires string content');
  const fullPath = resolveToolPath(filePath, ctx);
  await writeFileToolPath(fullPath, content, {
    overwrite: overwrite === true,
    existsMessage: `File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.`,
    createDirs: args.createDirs === true,
    parentPath: ctx.dirnameFilePath ? await dirnameToolPath(fullPath, ctx) : undefined,
  }, ctx.fileOperations);
  ctx.onResolvedPaths?.([{ raw: filePath, resolved: fullPath }]);
  return 'File written successfully';
}

export async function edit(args: ToolArgs, ctx: NodeToolContext = {}) {
  const edit = parseUnifiedEdit(args);
  if ('apply_patch' in edit) return apply_patch({ input: edit.apply_patch }, ctx);
  const { filePath, edits } = edit;
  const fullPath = resolveToolPath(filePath, ctx);
  const operations = ctx.fileOperations || nativeFileOperations;
  const content = (await readWholeFile(operations, fullPath)).toString('utf8');
  await operations.write(fullPath, applyTextEdits(content, edits), 'w');
  ctx.onResolvedPaths?.([{ raw: filePath, resolved: fullPath }]);
  return 'File edited successfully';
}

export async function apply_patch(args: ToolArgs, ctx: NodeToolContext = {}) {
  if (!args.input || typeof args.input !== 'string') throw new Error('apply_patch requires input string.');
  const paths: ResolvedToolPath[] = [];
  const result = await applyPatchOperations(
    args.input,
    filePath => {
      const fullPath = resolveToolPath(filePath, ctx);
      paths.push({ raw: filePath, resolved: fullPath });
      return { fullPath, displayPath: filePath };
    },
    ctx.fileOperations || nativeFileOperations,
    filePath => dirnameToolPath(filePath, ctx),
  );
  ctx.onResolvedPaths?.(paths);
  return result;
}

const sessionEventDispatchers = new Map<string, NonNullable<NodeToolContext['queueSystemEvent']>>();
let nodeSessionEventDispatcher: NodeSessionEventDispatcher | undefined;
const execManagers = new Map<string, PersistentExecManager>();

export function setNodeToolSessionEventDispatcher(dispatcher?: NodeSessionEventDispatcher): void {
  nodeSessionEventDispatcher = dispatcher;
}

function getExecManager(agentName: string): PersistentExecManager {
  const existing = execManagers.get(agentName);
  if (existing) return existing;
  const execTempDir = path.join(getNodeAgentDir(agentName), '.temp', 'exec');
  const manager = new PersistentExecManager({
    getDefaultCwd: () => process.cwd(),
    getExecTempDir: () => execTempDir,
    getAgentDir: getNodeAgentDir,
    registryPath: path.join(execTempDir, 'running-exec.json'),
    nodeId: process.env.FOXWARM_NODE_ID || 'remote-node',
    processOperations: nativeProcessOperations,
    completionDispatcher: async (entry: RunningExecEntry, status: ExecStatus, message: string) => {
      if (!entry.sessionId) return;
      const parsedFinishedAt = Date.parse(status.finishedAt);
      const metadata: NodeSessionEventMetadata | undefined = entry.completionCapability
        ? {
            eventId: `remote-exec-completion:${entry.id}`,
            execId: entry.id,
            completionCapability: entry.completionCapability,
            eventTimestamp: Number.isFinite(parsedFinishedAt) ? parsedFinishedAt : entry.startedAt,
          }
        : undefined;
      if (nodeSessionEventDispatcher) {
        await nodeSessionEventDispatcher(entry.sessionId, message, 'background', metadata);
        return;
      }
      const dispatcher = sessionEventDispatchers.get(entry.sessionId);
      if (!dispatcher) throw new Error(`No session event dispatcher is available for recovered exec \`${entry.id}\`.`);
      await dispatcher(message, 'background', metadata);
    },
  });
  execManagers.set(agentName, manager);
  return manager;
}

export async function initializeNodeToolExecRecovery(): Promise<void> {
  const agentDirs: string[] = [];
  if (process.env.FOXWARM_AGENT_DIR?.trim()) {
    agentDirs.push(getNodeAgentDir('main'));
  } else {
    const agentsRoot = path.dirname(getNodeAgentDir('__foxwarm_recovery_probe__'));
    let entries: Dirent[];
    try {
      entries = await fs.readdir(agentsRoot, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) agentDirs.push(path.join(agentsRoot, entry.name));
    }
  }

  for (const agentDir of agentDirs) {
    const registryPath = path.join(agentDir, '.temp', 'exec', 'running-exec.json');
    if (!await fs.pathExists(registryPath)) continue;
    let agentNames = [path.basename(agentDir)];
    try {
      const registry = await fs.readJson(registryPath);
      const persistedNames: string[] = Array.isArray(registry?.execs)
        ? (registry.execs as any[])
            .map((entry: any) => entry?.agentName)
            .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
        : [];
      if (persistedNames.length > 0) agentNames = [...new Set(persistedNames)];
    } catch {
      // PersistentExecManager owns canonical registry validation and diagnostics.
    }
    for (const agentName of agentNames) await getExecManager(agentName).initialize();
  }
}

export async function get_default_cwd() {
  return process.cwd();
}

export async function exec(args: ToolArgs, ctx: NodeToolContext = {}) {
  const command = String(args.command || '');
  if (!command.trim()) throw new Error('exec requires command');
  const resolvedTimeout = resolveExecTimeoutSeconds(args.timeout);
  const timeoutSeconds = resolvedTimeout.effectiveSeconds;
  if (ctx.externalOwner && (ctx.sessionId || ctx.session?.agent || !ctx.externalExecManager)) {
    throw new Error('External exec requires a real external owner and namespace.');
  }
  const agentName = ctx.externalOwner ? undefined : (ctx.session?.agent || 'main');
  if (ctx.sessionId && ctx.queueSystemEvent) sessionEventDispatchers.set(ctx.sessionId, ctx.queueSystemEvent);
  const manager = ctx.externalOwner ? ctx.externalExecManager! : getExecManager(agentName!);
  await manager.initialize();
  const entry = await manager.startPersistentExec({
    execId: ctx.backgroundExecId,
    command,
    ...(ctx.externalOwner ? { externalOwner: ctx.externalOwner } : { sessionId: ctx.sessionId, agentName }),
    nodeId: ctx.runtimeNodeId || ctx.session?.currentNode || process.env.FOXWARM_NODE_ID || 'remote-node',
    cwd: args.cwd,
    sessionCwd: ctx.externalOwner ? ctx.externalCwd : ctx.session?.cwd,
    completionCapability: ctx.completionCapability,
    onProcessStarted: ctx.onExecStarted,
    onBeforeProcessLaunch: () => {
      if (ctx.signal?.aborted) throw new Error('Exec was not started because Stop or Run queued cancelled it; the command was not executed.');
    },
  });
  const status = await manager.waitForExecCompletion(entry.id, timeoutSeconds * 1000, ctx.signal);
  const waitEndedBy = !status && ctx.signal?.aborted ? 'Stop or Run queued' : undefined;
  if (status) {
    try {
      const output = await manager.buildForegroundExecResult(entry, status, resolvedTimeout.warning);
      if (ctx.onExecForeground) ctx.onExecForeground(entry.id, output, await manager.getResolvedExecCwd(entry));
      return ctx.programmatic ? await manager.buildProgrammaticExecResult(entry, status, output) : output;
    } finally {
      await manager.finalizeForegroundExec(entry.id);
    }
  }
  if (ctx.registerBackgroundExec && entry.completionCapability) {
    await ctx.registerBackgroundExec({ execId: entry.id, completionCapability: entry.completionCapability });
  }
  ctx.onExecBackground?.(entry.id);
  await manager.markExecForBackgroundNotification(entry.id);
  const output = await manager.buildBackgroundTimeoutResult(entry, timeoutSeconds, resolvedTimeout.warning, waitEndedBy);
  return ctx.programmatic ? manager.buildProgrammaticExecResult(entry, null, output) : output;
}

export const nodeTools = { read, write, edit, apply_patch, exec, get_default_cwd };

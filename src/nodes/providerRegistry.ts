import { listApprovedNodes } from './registry';
import type { ExecRuntime } from '../execManager';
import type { ExecBackend, ExecStarted, ExecSnapshot } from '../../packages/shared/dist/execBackend';
import { resolveExecTimeoutSeconds, type ExecOutputFiles } from '../../packages/shared/dist/persistentExec';
import { createProviderExecBackend } from './providerExecBackend';
import path from 'node:path';
import { decodeNodeTransferFile } from '../nodeFileTransfer';
import { readPrimitiveTransferFile, writePrimitiveTransferFile, type NodeTransferFilePayload, type NodeTransferWriteResult } from '../../packages/shared/dist/nodeFileTransfer';
import { readWholeFile } from '../../packages/shared/dist/fileOperations';
import { RESOLVED_PATH_SIDECAR } from '../../packages/shared/dist/resolvedPathMetadata';
import { throwIfToolStopped } from '../toolCallControls';
import { NODE_ENVIRONMENT_BUILTIN_NAMES } from '../tools/placement';
import { nodesManager } from './manager';
import { CLI_NODE_CAPABILITIES } from '../../packages/shared/dist/nodeCapabilities';
import type { ExternalNodeOwner } from '../../packages/shared/dist/nodeProtocol';
import { describeNodeProtocolCompatibility, type NodeProtocolCompatibility } from '../../packages/shared/dist/nodeProtocol';
import { read, write, edit, apply_patch } from '../../packages/shared/dist/nodeTools';
import { parseApplyPatchInput } from '../../packages/shared/dist/applyPatch';
import { rejectUnsupportedAgentPathVariable } from '../../packages/shared/dist/agentPathVariables';
import type { FileOperations, FileOperationStat, FileOperationDirectoryEntry } from '../../packages/shared/dist/fileOperations';

export type NodeKind = 'master' | 'remote' | 'sandbox';
export type NodeAvailability = 'ready' | 'unavailable' | 'offline' | 'error';

export type NodeCapabilityDescriptor = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type NodeFilesystemAccess = 'read' | 'read-write';
export type NodePrimitiveBackends = {
  filesystem?: NodeFilesystemAccess;
  exec?: true;
};

export type NodeDescriptor = {
  id: string;
  kind: NodeKind;
  provider: string;
  type: string;
  label?: string;
  availability: NodeAvailability;
  tools: NodeCapabilityDescriptor[];
  /** Internal provider execution boundary. Omitted by complete-tool authenticated runtimes. */
  primitiveBackends?: NodePrimitiveBackends;
  lastActivity?: number;
  defaultCwd?: string;
  unavailable?: { code: string; message: string; retryable: boolean };
  protocolCompatibility?: NodeProtocolCompatibility;
};

/** Descriptor shape implemented by providers; primitive providers never supply model tool definitions. */
export type NodeProviderDescriptor = Omit<NodeDescriptor, 'tools'> & { tools?: NodeCapabilityDescriptor[] };

type NodeToolRequestBase = {
  nodeId: string;
  toolName: string;
  args: Record<string, unknown>;
};

export type NodeToolRequest = NodeToolRequestBase & ({
  sourceSessionId: string;
  owner?: never;
  context: {
    agent: string;
    currentNode?: string;
    cwd?: string;
    deferSessionCwdSync?: boolean;
    programmatic?: true;
    externalExec?: never;
  };
} | {
  owner: ExternalNodeOwner;
  sourceSessionId?: never;
  context: {
    agent?: never; currentNode?: string; cwd?: string; deferSessionCwdSync?: never; programmatic?: never;
    externalExec?: { execId: string; completionCapability: string };
  };
});

export type NodeDefaultCwdRequest = {
  sourceSessionId: string;
  nodeId: string;
  context: { agent: string };
};

export type NodeTransferReadRequest = NodeDefaultCwdRequest & { filePath: string };
export type NodeTransferWriteRequest = NodeTransferReadRequest & { dataBase64: string; overwrite: boolean };

export type NodeProviderCallOptions = {
  /** Dispatched exec start uses only hard cancellation; per-result read-only observations may use the foreground signal. */
  foregroundToolCancellation?: true;
  hardCancellationSignal?: AbortSignal;
  signal?: AbortSignal;
  /** Main-local external context fence, checked immediately before a provider effect. */
  assertExternalOwnerActive?: () => void;
};

export type NodeFilesystemOperation = 'parent' | 'stat' | 'read' | 'readdir' | 'write' | 'mkdir' | 'remove';
export type NodeFilesystemRequest = {
  sourceSessionId: string;
  nodeId: string;
  operation: NodeFilesystemOperation;
  path: string;
  offset?: number;
  count?: number;
  contentBase64?: string;
  flag?: 'w' | 'wx' | 'a';
  context: Extract<NodeToolRequest, { sourceSessionId: string }>['context'];
};

export type NodeExecStartRequest = { nodeId: string; command: string; cwd?: string };
export type NodeExecPollRequest = { nodeId: string; ref: string };

export type NodeProviderDescription = {
  label: string;
  description: string;
  lifecycle: NodeLifecycleAction[];
  createParameters?: unknown;
  ensureParameters?: unknown;
  lifecycleDescription?: string;
  dataRetention?: string;
};

export type NodeLifecycleAction = 'create' | 'ensure' | 'inspect' | 'destroy';

export type NodeLifecycleContext = {
  agent: string;
};

export type NodeLifecycleProviderRequest = {
  sourceSessionId: string;
  nodeId?: string;
  parameters: Record<string, unknown>;
  context: NodeLifecycleContext;
};

export type NodeLifecycleNodeRequest = NodeLifecycleProviderRequest & {
  nodeId: string;
};

export type NodeLifecycleResult = {
  provider?: NodeProviderDescription & { id: string };
  node?: NodeProviderDescriptor;
  nodeId?: string;
  effect?: string;
  dataRetention?: string;
  details?: unknown;
};

export type NodeProviderSummary = {
  id: string;
  label: string;
  lifecycle: NodeLifecycleAction[];
};

export interface NodeProvider {
  /** Cancellation ends foreground exec waiting with a real background receipt, never by killing its launcher. */
  readonly supportsExecWaitCancellation?: true;
  readonly id: string;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
  /** Expensive/failure-prone discovery is consulted only when fixed in-process providers do not own the exact Node ID. */
  readonly deferredLookup?: boolean;
  listNodes(options?: NodeProviderCallOptions): Promise<NodeProviderDescriptor[]> | NodeProviderDescriptor[];
  getNode(nodeId: string, options?: NodeProviderCallOptions): Promise<NodeProviderDescriptor | undefined> | NodeProviderDescriptor | undefined;
  /** Historical complete-tool adapter used only by authenticated resident Node runtimes. */
  invokeTool?(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown>;
  invokeFilesystem?(request: NodeFilesystemRequest, options?: NodeProviderCallOptions): Promise<unknown>;
  /** Complete internal file bytes, not a formatted or truncated model result. */
  readFile?(request: Extract<NodeToolRequest, { sourceSessionId: string }> & { toolName: 'read' }, options?: NodeProviderCallOptions): Promise<Buffer>;
  readTransferFile?(request: NodeTransferReadRequest): Promise<NodeTransferFilePayload>;
  writeTransferFile?(request: NodeTransferWriteRequest): Promise<NodeTransferWriteResult>;
  describe?(options?: NodeProviderCallOptions): Promise<NodeProviderDescription>;
  startExec?(request: NodeExecStartRequest, options?: NodeProviderCallOptions): Promise<ExecStarted>;
  pollExec?(request: NodeExecPollRequest): Promise<ExecSnapshot>;
  getDefaultCwd?(request: NodeDefaultCwdRequest, options?: NodeProviderCallOptions): Promise<string | undefined>;
  createNode?(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult>;
  ensureNode?(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult>;
  inspectNode?(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult>;
  destroyNode?(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult>;
}

export class NodeProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'NodeProviderError';
  }
}

export class NodeProviderRegistry {
  private readonly providers: NodeProvider[];
  private mutationTail: Promise<void> = Promise.resolve();
  private initializationPromise?: Promise<void>;
  private initialized = false;
  private shutdownPromise?: Promise<void>;
  private shutDown = false;

  constructor(providers: readonly NodeProvider[], private readonly options: { getExecRuntime?: () => ExecRuntime } = {}) {
    const ids = new Set<string>();
    for (const provider of providers) {
      if (!provider.id || ids.has(provider.id)) {
        throw new Error(`Node provider id must be unique: ${provider.id || '(empty)'}`);
      }
      ids.add(provider.id);
    }
    this.providers = [...providers];
  }

  async initialize(): Promise<void> {
    if (this.shutDown) throw new Error('Node provider registry is shut down.');
    if (this.initialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const initialized: NodeProvider[] = [];
        try {
          for (const provider of this.providers) { initialized.push(provider); await provider.initialize?.(); }
          this.initialized = true;
        } catch (error) {
          await Promise.allSettled(initialized.reverse().map(provider => provider.shutdown?.()));
          throw error;
        }
      })().finally(() => { this.initializationPromise = undefined; });
    }
    await this.initializationPromise;
  }

  async shutdown(): Promise<void> {
    if (this.shutDown) return;
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.initializationPromise) await this.initializationPromise.catch(() => {});
      const results = await Promise.allSettled([...this.providers].reverse().map(provider => provider.shutdown?.()));
      this.initialized = false; this.shutDown = true;
      const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    })().finally(() => { this.shutdownPromise = undefined; });
    return this.shutdownPromise;
  }

  async listNodes(options?: NodeProviderCallOptions): Promise<NodeDescriptor[]> {
    const nodes: NodeDescriptor[] = [];
    const owners = new Map<string, string>();
    for (const provider of this.providers) {
      for (const rawNode of await provider.listNodes(options)) {
        const node = this.materializeDescriptor(rawNode, provider);
        if (node.provider !== provider.id) {
          throw new NodeProviderError(
            'NODE_PROVIDER_INVALID_DESCRIPTOR',
            `Node \`${node.id}\` descriptor provider must be \`${provider.id}\`.`,
          );
        }
        const existing = owners.get(node.id);
        if (existing) {
          throw new NodeProviderError(
            'NODE_PROVIDER_DUPLICATE_NODE',
            `Node \`${node.id}\` is advertised by both \`${existing}\` and \`${provider.id}\`.`,
          );
        }
        owners.set(node.id, provider.id);
        nodes.push(node);
      }
    }
    return nodes;
  }

  async resolveNode(nodeId: string, options?: NodeProviderCallOptions): Promise<{ descriptor: NodeDescriptor; provider: NodeProvider } | undefined> {
    const immediate = this.providers.filter(provider => provider.deferredLookup !== true);
    const deferred = this.providers.filter(provider => provider.deferredLookup === true);
    const direct = await this.resolveNodeFromProviders(nodeId, immediate, options);
    if (direct) return direct;
    return this.resolveNodeFromProviders(nodeId, deferred, options);
  }

  private async resolveNodeFromProviders(
    nodeId: string,
    providers: readonly NodeProvider[],
    options?: NodeProviderCallOptions,
  ): Promise<{ descriptor: NodeDescriptor; provider: NodeProvider } | undefined> {
    let resolved: { descriptor: NodeDescriptor; provider: NodeProvider } | undefined;
    for (const provider of providers) {
      const rawDescriptor = await provider.getNode(nodeId, options);
      if (!rawDescriptor) continue;
      const descriptor = this.materializeDescriptor(rawDescriptor, provider);
      if (descriptor.id !== nodeId || descriptor.provider !== provider.id) {
        throw new NodeProviderError(
          'NODE_PROVIDER_INVALID_DESCRIPTOR',
          `Node \`${nodeId}\` resolved an inconsistent descriptor from provider \`${provider.id}\`.`,
        );
      }
      if (resolved) {
        throw new NodeProviderError(
          'NODE_PROVIDER_DUPLICATE_NODE',
          `Node \`${nodeId}\` is advertised by both \`${resolved.provider.id}\` and \`${provider.id}\`.`,
        );
      }
      resolved = { descriptor, provider };
    }
    return resolved;
  }

  private async resolveAvailableTool(request: NodeToolRequest, options?: NodeProviderCallOptions) {
    const resolved = await this.resolveNode(request.nodeId, options);
    if (!resolved || resolved.descriptor.availability !== 'ready') {
      if (resolved?.descriptor.unavailable) {
        throw new NodeProviderError(
          resolved.descriptor.unavailable.code,
          resolved.descriptor.unavailable.message,
          resolved.descriptor.unavailable.retryable,
        );
      }
      throw new NodeProviderError(
        'NODE_EXECUTION_NODE_UNAVAILABLE',
        `Node \`${request.nodeId}\` is not available.`,
        true,
      );
    }
    if (!resolved.descriptor.tools.some(tool => tool.name === request.toolName)) {
      throw new NodeProviderError(
        'NODE_EXECUTION_TOOL_UNAVAILABLE',
        `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`,
      );
    }
    return resolved;
  }

  async invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown> {
    const resolved = await this.resolveAvailableTool(request, options);
    if (options?.foregroundToolCancellation) {
      throwIfToolStopped(options.signal);
      options = { ...options, signal: request.toolName === 'exec' && (resolved.provider.supportsExecWaitCancellation || resolved.descriptor.primitiveBackends?.exec)
        ? options.signal : options.hardCancellationSignal };
    }
    if (resolved.descriptor.primitiveBackends) {
      if (request.owner) {
        throw new NodeProviderError('NODE_EXTERNAL_OWNER_UNSUPPORTED', `Node \`${request.nodeId}\` does not yet support external-owner primitive tools.`);
      }
      return this.invokePrimitiveTool(resolved.provider, resolved.descriptor,
        request as Extract<NodeToolRequest, { sourceSessionId: string }>, options);
    }
    if (!resolved.provider.invokeTool) {
      throw new NodeProviderError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`);
    }
    return resolved.provider.invokeTool(request, options);
  }

  async readFile(request: Extract<NodeToolRequest, { sourceSessionId: string }> & { toolName: 'read' }, options?: NodeProviderCallOptions): Promise<Buffer> {
    const { descriptor, provider } = await this.resolveAvailableTool(request, options);
    if (descriptor.primitiveBackends?.filesystem && provider.invokeFilesystem) {
      const filePath = request.args.filePath;
      if (typeof filePath !== 'string' || !filePath) throw new NodeProviderError('NODE_FILE_READ_INVALID_PATH', 'filePath is required.');
      rejectUnsupportedAgentPathVariable(filePath);
      const { operations } = this.filesystemBackend(provider, request, options);
      const stat = await operations.stat(filePath);
      if (stat.kind === 'directory') throw new NodeProviderError('NODE_FILE_READ_NOT_FILE', 'Source path is a directory.');
      const bytes = await readWholeFile(operations, filePath);
      if (bytes.length !== stat.size) throw new NodeProviderError('NODE_FILE_READ_INCOMPLETE', 'Source file changed or the filesystem returned incomplete data.');
      return bytes;
    }
    if (provider.readFile) return provider.readFile(request, options);
    throw new NodeProviderError('NODE_FILE_READ_UNAVAILABLE', `Node \`${request.nodeId}\` does not support complete file reads.`);
  }

  async readTransferFile(request: NodeTransferReadRequest): Promise<NodeTransferFilePayload> {
    const resolved = await this.resolveNode(request.nodeId);
    if (!resolved) throw new NodeProviderError('NODE_EXECUTION_NODE_UNAVAILABLE', `Node \`${request.nodeId}\` is not available.`);
    if (!resolved.descriptor.primitiveBackends) {
      if (resolved.provider.readTransferFile) return resolved.provider.readTransferFile(request);
      throw new NodeProviderError('NODE_FILE_TRANSFER_UNAVAILABLE', `Node \`${request.nodeId}\` does not support file transfer.`);
    }
    const toolRequest = { sourceSessionId: request.sourceSessionId, nodeId: request.nodeId,
      toolName: 'read', args: { filePath: request.filePath }, context: request.context };
    await this.resolveAvailableTool(toolRequest);
    rejectUnsupportedAgentPathVariable(request.filePath);
    const { operations } = this.filesystemBackend(resolved.provider, toolRequest);
    return readPrimitiveTransferFile(request.filePath, operations);
  }

  async writeTransferFile(request: NodeTransferWriteRequest): Promise<NodeTransferWriteResult> {
    const resolved = await this.resolveNode(request.nodeId);
    if (!resolved) throw new NodeProviderError('NODE_EXECUTION_NODE_UNAVAILABLE', `Node \`${request.nodeId}\` is not available.`);
    if (!resolved.descriptor.primitiveBackends) {
      if (resolved.provider.writeTransferFile) return resolved.provider.writeTransferFile(request);
      throw new NodeProviderError('NODE_FILE_TRANSFER_UNAVAILABLE', `Node \`${request.nodeId}\` does not support file transfer.`);
    }
    const toolRequest = { sourceSessionId: request.sourceSessionId, nodeId: request.nodeId,
      toolName: 'write', args: { filePath: request.filePath }, context: request.context };
    await this.resolveAvailableTool(toolRequest);
    rejectUnsupportedAgentPathVariable(request.filePath);
    const { operations, providerParent } = this.filesystemBackend(resolved.provider, toolRequest);
    return writePrimitiveTransferFile(request.filePath, Buffer.from(request.dataBase64, 'base64'), request.overwrite, operations, providerParent);
  }

  private materializeDescriptor(descriptor: NodeProviderDescriptor, provider?: NodeProvider): NodeDescriptor {
    if (!descriptor.primitiveBackends) return { ...descriptor, tools: descriptor.tools || [] };
    const backendKeys = Object.keys(descriptor.primitiveBackends);
    if (backendKeys.some(key => key !== 'filesystem' && key !== 'exec')
      || (descriptor.primitiveBackends.filesystem !== undefined
        && descriptor.primitiveBackends.filesystem !== 'read'
        && descriptor.primitiveBackends.filesystem !== 'read-write')
      || (descriptor.primitiveBackends.exec !== undefined && descriptor.primitiveBackends.exec !== true)
      || (descriptor.primitiveBackends.filesystem === undefined && descriptor.primitiveBackends.exec !== true)) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${descriptor.id}\` has invalid primitive backend support.`);
    }
    if (descriptor.tools !== undefined) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Primitive Node \`${descriptor.id}\` must not advertise model tool definitions.`);
    }
    if (provider && descriptor.primitiveBackends.filesystem && !provider.invokeFilesystem) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Primitive Node \`${descriptor.id}\` advertises filesystem support without a filesystem backend.`);
    }
    if (provider && descriptor.primitiveBackends.exec && (!provider.startExec || !provider.pollExec || !descriptor.primitiveBackends.filesystem)) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Primitive Node \`${descriptor.id}\` advertises exec support without an exec backend.`);
    }
    const names = new Set<string>();
    if (descriptor.primitiveBackends.filesystem) names.add('read');
    if (descriptor.primitiveBackends.filesystem === 'read-write') {
      names.add('write'); names.add('edit'); names.add('apply_patch');
    }
    if (descriptor.primitiveBackends.exec) names.add('exec');
    const tools = CLI_NODE_CAPABILITIES.tools
      .filter(tool => names.has(tool.name))
      .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    return { ...descriptor, tools };
  }

  private async invokePrimitiveTool(
    provider: NodeProvider,
    descriptor: NodeDescriptor,
    request: Extract<NodeToolRequest, { sourceSessionId: string }>,
    options?: NodeProviderCallOptions,
  ): Promise<unknown> {
    if (request.toolName === 'exec') {
      rejectUnsupportedAgentPathVariable(request.args.cwd);
      if (!descriptor.primitiveBackends?.exec || !provider.startExec || !provider.pollExec) {
        throw new NodeProviderError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`exec\` not available on node \`${request.nodeId}\`.`);
      }
      return this.invokePrimitiveExec(provider, request, options);
    }
    const access = descriptor.primitiveBackends?.filesystem;
    const mutation = request.toolName === 'write' || request.toolName === 'edit' || request.toolName === 'apply_patch';
    if (!access || (mutation && access !== 'read-write') || !provider.invokeFilesystem) {
      throw new NodeProviderError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`);
    }
    if (request.toolName === 'apply_patch' && typeof request.args.input === 'string') {
      for (const operation of parseApplyPatchInput(request.args.input)) rejectUnsupportedAgentPathVariable(operation.filePath);
    } else {
      rejectUnsupportedAgentPathVariable(request.args.filePath);
    }
    const { operations, providerParent } = this.filesystemBackend(provider, request, options);
    const context = {
      sessionId: request.sourceSessionId,
      session: { agent: request.context.agent, cwd: request.context.cwd, currentNode: request.nodeId },
      ...(request.context.programmatic ? { programmatic: true as const } : {}),
      fileOperations: operations,
      resolveFilePath: (filePath: string) => filePath,
      dirnameFilePath: providerParent,
    };
    const tool = { read, write, edit, apply_patch }[request.toolName as 'read' | 'write' | 'edit' | 'apply_patch'];
    if (!tool) throw new NodeProviderError('NODE_EXECUTION_TOOL_UNAVAILABLE', `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`);
    return tool(request.args, context);
  }

  /** Reattach only to the exact configured provider, not to another current owner of the Node ID. */
  execBackend(providerId: string, nodeId: string): ExecBackend {
    const provider = this.providers.find(candidate => candidate.id === providerId);
    if (!provider?.startExec || !provider.pollExec || !provider.invokeFilesystem) throw new Error('Configured Node provider exec backend is unavailable.');
    const { operations } = this.filesystemBackend(provider, {
      sourceSessionId: '', nodeId, toolName: 'read', args: {}, context: { agent: '' },
    });
    return createProviderExecBackend(provider, nodeId, operations);
  }

  private async invokePrimitiveExec(provider: NodeProvider, request: Extract<NodeToolRequest, { sourceSessionId: string }>, options?: NodeProviderCallOptions): Promise<unknown> {
    const runtime = this.options.getExecRuntime?.();
    if (!runtime) throw new Error('Node provider exec runtime is unavailable.');
    const command = request.args.command;
    if (typeof command !== 'string' || !command.trim()) throw new Error('exec requires command');
    const timeout = resolveExecTimeoutSeconds(request.args.timeout);
    await runtime.initialize();
    const entry = await runtime.startPersistentExec({
      backend: { providerId: provider.id }, nodeId: request.nodeId,
      command, cwd: request.args.cwd, sessionCwd: request.context.currentNode === request.nodeId ? request.context.cwd : undefined,
      sessionId: request.sourceSessionId, agentName: request.context.agent,
      onBeforeProcessLaunch: () => throwIfToolStopped(options?.signal),
      hardCancellationSignal: options?.hardCancellationSignal,
    });
    const waitDeadline = Date.now() + timeout.effectiveSeconds * 1000;
    const status = await runtime.waitForExecCompletion(entry.id, timeout.effectiveSeconds * 1000, options?.signal);
    if (!status) await runtime.markExecForBackgroundNotification(entry.id);
    // Preserve quick partial snapshots after a normal wait timeout, but never
    // turn formatting into another provider-sized wait (or persist its signal).
    const outputController = new AbortController();
    const outputBudget = status ? Math.max(0, waitDeadline - Date.now()) : 500;
    const timer = setTimeout(() => outputController.abort(), outputBudget);
    if (outputBudget <= 0) outputController.abort();
    const signal = AbortSignal.any([outputController.signal, ...[options?.signal, options?.hardCancellationSignal].filter((value): value is AbortSignal => !!value)]);
    try {
      const { operations } = this.filesystemBackend(provider, request, { signal });
      const observe = <T>(read: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const cancel = () => reject(signal.reason);
        if (signal.aborted) { cancel(); return; }
        signal.addEventListener('abort', cancel, { once: true });
        // Race independently as well as cancelling the adapter: an in-process
        // provider that ignores its signal still cannot extend this receipt.
        Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(value => {
          signal.removeEventListener('abort', cancel);
          resolve(value);
        }, error => {
          signal.removeEventListener('abort', cancel);
          reject(error);
        });
      });
      const files: ExecOutputFiles = {
        stat: filePath => observe(() => operations.stat(filePath)),
        read: (filePath, offset, count) => observe(() => operations.read(filePath, offset, count)),
      };
      try {
        const output = status
          ? await runtime.buildForegroundExecResult(entry, status, timeout.warning, files)
          : await runtime.buildBackgroundTimeoutResult(entry, timeout.effectiveSeconds, timeout.warning, options?.signal?.aborted ? 'Stop or Run queued' : undefined, files);
        const nextCwd = status ? await runtime.readFinishedExecWorkingDirectory(entry) : await runtime.readLiveExecWorkingDirectory(entry);
        const result = request.context.programmatic ? await runtime.buildProgrammaticExecResult(entry, status, output, files) : { output };
        return nextCwd && request.context.currentNode === request.nodeId
          ? { ...result, __execBatchCwdSync: { nextCwd, nodeId: request.nodeId } } : result;
      } finally {
        if (status) await runtime.finalizeForegroundExec(entry.id);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private filesystemBackend(provider: NodeProvider, request: Extract<NodeToolRequest, { sourceSessionId: string }>, options?: NodeProviderCallOptions) {
    const call = async (operation: NodeFilesystemOperation, fields: Partial<NodeFilesystemRequest>) => {
      return provider.invokeFilesystem!({
        sourceSessionId: request.sourceSessionId,
        nodeId: request.nodeId,
        operation,
        path: fields.path!,
        ...(fields.offset === undefined ? {} : { offset: fields.offset }),
        ...(fields.count === undefined ? {} : { count: fields.count }),
        ...(fields.contentBase64 === undefined ? {} : { contentBase64: fields.contentBase64 }),
        ...(fields.flag === undefined ? {} : { flag: fields.flag }),
        context: { ...request.context, cwd: request.context.currentNode === request.nodeId ? request.context.cwd : undefined },
      }, options);
    };
    const operations: FileOperations = {
      stat: async filePath => this.normalizeFileStat(await call('stat', { path: filePath })),
      read: async (filePath, offset, count) => {
        const result = await call('read', { path: filePath, offset, count });
        if (!result || typeof result !== 'object' || typeof (result as any).dataBase64 !== 'string') {
          throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem read returned an invalid result.');
        }
        const data = Buffer.from((result as any).dataBase64, 'base64');
        if (data.toString('base64') !== (result as any).dataBase64 || data.length > count) {
          throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem read returned non-canonical or oversized bytes.');
        }
        return data;
      },
      readdir: async filePath => {
        const result = await call('readdir', { path: filePath });
        if (!Array.isArray(result)) throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem readdir returned an invalid result.');
        return result.map(item => ({ ...this.normalizeFileStat(item), name: typeof item?.name === 'string' ? item.name : (() => { throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem readdir returned an invalid entry.'); })() })) as FileOperationDirectoryEntry[];
      },
      write: async (filePath, content, flag) => { await call('write', { path: filePath, contentBase64: Buffer.from(content).toString('base64'), flag }); },
      mkdir: async filePath => { await call('mkdir', { path: filePath }); },
      remove: async filePath => { await call('remove', { path: filePath }); },
    };
    const providerParent = async (value: string): Promise<string> => {
      const result = await call('parent', { path: value });
      if (!result || typeof result !== 'object' || typeof (result as any).path !== 'string' || !(result as any).path) {
        throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem parent returned an invalid result.');
      }
      return (result as any).path;
    };
    return { operations, providerParent };
  }

  private normalizeFileStat(value: any): FileOperationStat {
    if (!value || typeof value !== 'object' || !['file', 'directory', 'symlink', 'other'].includes(value.kind)
      || !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.modifiedAtMs !== 'number' || !Number.isFinite(value.modifiedAtMs)) {
      throw new NodeProviderError('NODE_PROVIDER_FILESYSTEM_INVALID_RESULT', 'Filesystem stat returned an invalid result.');
    }
    return { kind: value.kind, size: value.size, modifiedAtMs: value.modifiedAtMs };
  }

  async inspectProvider(providerId: string, options?: NodeProviderCallOptions): Promise<NodeProviderDescription & { id: string }> {
    const provider = this.providers.find(candidate => candidate.id === providerId);
    if (!provider) throw new NodeProviderError('NODE_LIFECYCLE_PROVIDER_NOT_FOUND', `Node provider \`${providerId}\` is not configured.`);
    const actions: NodeLifecycleAction[] = [];
    if (provider.createNode) actions.push('create');
    if (provider.ensureNode) actions.push('ensure');
    if (provider.inspectNode) actions.push('inspect');
    if (provider.destroyNode) actions.push('destroy');
    return { ...(provider.describe ? await provider.describe(options) : {
      label: provider.id, description: 'Execution environments exposed by this provider.', lifecycle: actions,
    }), id: provider.id };
  }

  async listProviders(options?: NodeProviderCallOptions): Promise<NodeProviderSummary[]> {
    return Promise.all(this.providers.map(async provider => {
      const description = await this.inspectProvider(provider.id, options);
      return { id: description.id, label: description.label, lifecycle: description.lifecycle };
    }));
  }

  async createNode(providerId: string, request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    return this.withMutationLane(options, () => this.invokeProviderLifecycle('create', providerId, request, options));
  }

  async ensureNode(providerId: string, request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    return this.withMutationLane(options, () => this.invokeProviderLifecycle('ensure', providerId, request, options));
  }

  async inspectNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    return this.invokeNodeLifecycle('inspect', request, options);
  }

  async destroyNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    return this.withMutationLane(options, () => this.invokeNodeLifecycle('destroy', request, options));
  }

  private async withMutationLane<T>(options: NodeProviderCallOptions | undefined, effect: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (options?.signal?.aborted) {
        throw new NodeProviderError(
          'NODE_LIFECYCLE_CANCELLED',
          'Node lifecycle mutation was cancelled before provider execution.',
          true,
        );
      }
      return await effect();
    } finally {
      release();
    }
  }

  private async invokeProviderLifecycle(
    action: 'create' | 'ensure',
    providerId: string,
    request: NodeLifecycleProviderRequest,
    options?: NodeProviderCallOptions,
  ): Promise<NodeLifecycleResult> {
    if (request.nodeId !== undefined && (
      request.nodeId.length < 1
      || request.nodeId.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(request.nodeId)
      || request.nodeId.toLowerCase() === 'master'
    )) {
      throw new NodeProviderError(
        'NODE_LIFECYCLE_INVALID_NODE_ID',
        'create/ensure nodeId must use the canonical slash-free grammar and cannot be reserved `master`.',
      );
    }
    const provider = this.providers.find(candidate => candidate.id === providerId);
    if (!provider) {
      throw new NodeProviderError('NODE_LIFECYCLE_PROVIDER_NOT_FOUND', `Node provider \`${providerId}\` is not configured.`);
    }
    const method = action === 'create' ? provider.createNode : provider.ensureNode;
    if (!method || (provider.describe && !(await provider.describe(options)).lifecycle.includes(action))) {
      throw new NodeProviderError('NODE_LIFECYCLE_OPERATION_UNSUPPORTED', `Node provider \`${providerId}\` does not support \`${action}\`.`);
    }
    if (request.nodeId) {
      const existing = await this.resolveNodeAcrossAllProviders(request.nodeId, options);
      if (action === 'create' && existing) {
        throw new NodeProviderError(
          'NODE_LIFECYCLE_NODE_EXISTS',
          `Node \`${request.nodeId}\` is already owned by provider \`${existing.provider.id}\`; create was not invoked.`,
        );
      }
      if (action === 'ensure' && existing && existing.provider.id !== provider.id) {
        throw new NodeProviderError(
          'NODE_LIFECYCLE_NODE_OWNED_BY_OTHER_PROVIDER',
          `Node \`${request.nodeId}\` is owned by provider \`${existing.provider.id}\`, not \`${provider.id}\`; ensure was not invoked.`,
        );
      }
    }
    let result: NodeLifecycleResult;
    try {
      result = await method.call(provider, request, options);
    } catch (error) {
      if (error instanceof NodeProviderError) throw error;
      throw new NodeProviderError(
        'NODE_LIFECYCLE_PROVIDER_FAILED',
        `Node provider \`${provider.id}\` failed \`${action}\`.`,
        true,
      );
    }
    this.validateLifecycleResult(action, result, provider.id, request.nodeId);
    if (result.node) await this.assertNoOtherProviderOwns(result.node.id, provider.id, options);
    return result;
  }

  private async invokeNodeLifecycle(
    action: 'inspect' | 'destroy',
    request: NodeLifecycleNodeRequest,
    options?: NodeProviderCallOptions,
  ): Promise<NodeLifecycleResult> {
    const resolved = await this.resolveNodeAcrossAllProviders(request.nodeId, options);
    if (!resolved) {
      throw new NodeProviderError('NODE_EXECUTION_NODE_UNAVAILABLE', `Node \`${request.nodeId}\` is not available.`, true);
    }
    const method = action === 'inspect' ? resolved.provider.inspectNode : resolved.provider.destroyNode;
    if (!method || (resolved.provider.describe && !(await resolved.provider.describe(options)).lifecycle.includes(action))) {
      throw new NodeProviderError(
        'NODE_LIFECYCLE_OPERATION_UNSUPPORTED',
        `Node provider \`${resolved.provider.id}\` does not support \`${action}\` for Node \`${request.nodeId}\`.`,
      );
    }
    let result: NodeLifecycleResult;
    try {
      result = await method.call(resolved.provider, request, options);
    } catch (error) {
      if (error instanceof NodeProviderError) throw error;
      throw new NodeProviderError(
        'NODE_LIFECYCLE_PROVIDER_FAILED',
        `Node provider \`${resolved.provider.id}\` failed \`${action}\` for Node \`${request.nodeId}\`.`,
        true,
      );
    }
    this.validateLifecycleResult(action, result, resolved.provider.id, request.nodeId);
    return result;
  }

  private validateLifecycleResult(
    action: NodeLifecycleAction,
    result: NodeLifecycleResult,
    providerId: string,
    expectedNodeId?: string,
  ): void {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new NodeProviderError('NODE_LIFECYCLE_INVALID_RESULT', `Node provider \`${providerId}\` returned an invalid \`${action}\` result.`);
    }
    const unexpected = Object.keys(result).find(key => !['node', 'nodeId', 'effect', 'dataRetention', 'details'].includes(key));
    if (unexpected) {
      throw new NodeProviderError(
        'NODE_LIFECYCLE_INVALID_RESULT',
        `Node provider \`${providerId}\` returned unsupported lifecycle result field \`${unexpected}\`.`,
      );
    }
    for (const field of ['effect', 'dataRetention'] as const) {
      const value = result[field];
      if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > 4_096
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) {
        throw new NodeProviderError(
          'NODE_LIFECYCLE_INVALID_RESULT',
          `Node provider \`${providerId}\` returned invalid lifecycle result field \`${field}\`.`,
        );
      }
    }
    if (action === 'create' || action === 'ensure' || action === 'inspect') {
      if (!result.node || result.node.provider !== providerId) {
        throw new NodeProviderError('NODE_LIFECYCLE_INVALID_RESULT', `Node provider \`${providerId}\` must return its exact Node descriptor for \`${action}\`.`);
      }
      result.node = this.materializeDescriptor(result.node, this.providers.find(provider => provider.id === providerId));
      if (expectedNodeId && result.node.id !== expectedNodeId) {
        throw new NodeProviderError('NODE_LIFECYCLE_NODE_MISMATCH', `Node provider \`${providerId}\` returned the wrong Node identity for \`${action}\`.`);
      }
    }
    if (action === 'destroy' && result.nodeId !== expectedNodeId) {
      throw new NodeProviderError('NODE_LIFECYCLE_NODE_MISMATCH', `Node provider \`${providerId}\` returned the wrong Node identity for \`destroy\`.`);
    }
  }

  private async resolveNodeAcrossAllProviders(
    nodeId: string,
    options?: NodeProviderCallOptions,
  ): Promise<{ descriptor: NodeDescriptor; provider: NodeProvider } | undefined> {
    return this.resolveNodeFromProviders(nodeId, this.providers, options);
  }

  private async assertNoOtherProviderOwns(nodeId: string, providerId: string, options?: NodeProviderCallOptions): Promise<void> {
    for (const provider of this.providers) {
      if (provider.id === providerId) continue;
      const descriptor = await provider.getNode(nodeId, options);
      if (descriptor) {
        throw new NodeProviderError(
          'NODE_PROVIDER_DUPLICATE_NODE',
          `Node \`${nodeId}\` is advertised by both \`${providerId}\` and \`${provider.id}\`.`,
        );
      }
    }
  }

  async getDefaultCwd(request: NodeDefaultCwdRequest, options?: NodeProviderCallOptions): Promise<string | undefined> {
    const resolved = await this.resolveNode(request.nodeId, options);
    if (!resolved || resolved.descriptor.availability !== 'ready') {
      if (resolved?.descriptor.unavailable) {
        throw new NodeProviderError(
          resolved.descriptor.unavailable.code,
          resolved.descriptor.unavailable.message,
          resolved.descriptor.unavailable.retryable,
        );
      }
      throw new NodeProviderError(
        'NODE_EXECUTION_NODE_UNAVAILABLE',
        `Node \`${request.nodeId}\` is not available.`,
        true,
      );
    }
    if (typeof resolved.descriptor.defaultCwd === 'string' && resolved.descriptor.defaultCwd.length > 0) {
      return resolved.descriptor.defaultCwd;
    }
    return resolved.provider.getDefaultCwd?.(request, options);
  }
}

function masterTools(): NodeCapabilityDescriptor[] {
  return NODE_ENVIRONMENT_BUILTIN_NAMES.map(name => {
    const definition = nodesManager.getToolDefinition(name);
    return definition
      ? { name, description: definition.description, parameters: definition.parameters }
      : { name };
  });
}

export class MasterNodeProvider implements NodeProvider {
  readTransferFile(request: NodeTransferReadRequest): Promise<NodeTransferFilePayload> {
    return nodesManager.readFileFromNode(request.nodeId, request.filePath, request.sourceSessionId);
  }
  writeTransferFile(request: NodeTransferWriteRequest): Promise<NodeTransferWriteResult> {
    return nodesManager.writeFileToNode(request.nodeId, request.filePath, request.dataBase64, request.overwrite, request.sourceSessionId);
  }

  readonly id = 'master';
  async describe(): Promise<NodeProviderDescription> {
    return { label: 'Main host', description: 'The colocated Main execution environment.', lifecycle: [] };
  }

  private descriptor(): NodeDescriptor {
    const lastActivity = nodesManager.listNodes().find(node => node.id === 'master')?.lastActivity;
    return {
      id: 'master',
      kind: 'master',
      provider: this.id,
      type: 'master',
      availability: 'ready',
      tools: masterTools(),
      ...(typeof lastActivity === 'number' ? { lastActivity } : {}),
    };
  }

  listNodes(): NodeDescriptor[] {
    return [this.descriptor()];
  }

  getNode(nodeId: string): NodeDescriptor | undefined {
    return nodeId === 'master' ? this.descriptor() : undefined;
  }

  async invokeTool(request: NodeToolRequest): Promise<unknown> {
    throw new NodeProviderError(
      'NODE_EXECUTION_MASTER_FORBIDDEN',
      `The colocated master node must execute \`${request.toolName}\` directly without Node execution RPC.`,
    );
  }
}

export class AuthenticatedRemoteNodeProvider implements NodeProvider {
  readTransferFile(request: NodeTransferReadRequest): Promise<NodeTransferFilePayload> {
    return nodesManager.readFileFromNode(request.nodeId, request.filePath, request.sourceSessionId);
  }
  writeTransferFile(request: NodeTransferWriteRequest): Promise<NodeTransferWriteResult> {
    return nodesManager.writeFileToNode(request.nodeId, request.filePath, request.dataBase64, request.overwrite, request.sourceSessionId);
  }

  readonly supportsExecWaitCancellation = true;
  readonly id = 'authenticated-remote';
  async describe(): Promise<NodeProviderDescription> {
    return { label: 'Authenticated Nodes', description: 'Resident Nodes connected through authenticated CLI, HTTP or WebSocket transports. Pairing and revocation are managed separately.', lifecycle: [] };
  }

  private descriptorForRuntimeNode(nodeId: string): NodeDescriptor | undefined {
    const node: any = nodesManager.getNode(nodeId);
    if (!node || nodeId === 'master' || (!node.ws && !node.httpExec)) return undefined;
    const compatibility = node.protocolCompatibility as NodeProtocolCompatibility | undefined;
    if (compatibility?.status === 'upgrade-required') {
      const message = `Node \`${nodeId}\` is connected but cannot execute tools. ${describeNodeProtocolCompatibility(compatibility)}`;
      return {
        id: nodeId,
        kind: 'remote',
        provider: this.id,
        type: typeof node.type === 'string' && node.type ? node.type : 'remote',
        availability: 'error',
        tools: [],
        unavailable: { code: 'NODE_PROTOCOL_INCOMPATIBLE', message, retryable: false },
        protocolCompatibility: compatibility,
        ...(typeof node.lastActivity === 'number' ? { lastActivity: node.lastActivity } : {}),
      };
    }
    const advertised = Array.isArray(node.capabilities?.tools)
      ? node.capabilities.tools
      : [...(node.tools || [])].map((name: string) => {
          const definition = nodesManager.getToolDefinition(name);
          return definition
            ? { name, description: definition.description, parameters: definition.parameters }
            : { name };
        });
    return {
      id: nodeId,
      kind: 'remote',
      provider: this.id,
      type: typeof node.type === 'string' && node.type ? node.type : 'remote',
      availability: 'ready',
      tools: advertised,
      ...(compatibility ? { protocolCompatibility: compatibility } : {}),
      ...(typeof node.lastActivity === 'number' ? { lastActivity: node.lastActivity } : {}),
    };
  }

  async listNodes(): Promise<NodeDescriptor[]> {
    const activity = new Map(nodesManager.listNodes().map(node => [node.id, node.lastActivity]));
    const described: NodeDescriptor[] = nodesManager.listNodesWithTools()
      .filter(node => node.id !== 'master')
      .map(node => ({
        id: node.id,
        kind: 'remote' as const,
        provider: this.id,
        type: node.type,
        availability: 'ready' as const,
        tools: node.tools,
        ...(this.descriptorForRuntimeNode(node.id)?.protocolCompatibility ? { protocolCompatibility: this.descriptorForRuntimeNode(node.id)!.protocolCompatibility } : {}),
        ...(typeof activity.get(node.id) === 'number' ? { lastActivity: activity.get(node.id) } : {}),
      }));
    const known = new Set(described.map(node => node.id));
    for (const node of nodesManager.listNodes()) {
      if (node.id === 'master' || known.has(node.id)) continue;
      const descriptor = this.descriptorForRuntimeNode(node.id);
      if (descriptor) described.push(descriptor);
    }
    for (const approved of await listApprovedNodes()) {
      if (described.some(node => node.id === approved.nodeId)) continue;
      described.push({ id: approved.nodeId, kind: 'remote', provider: this.id, type: approved.nodeType,
        availability: 'offline', tools: [], label: approved.displayName || approved.requestedName || approved.nodeId,
        ...(approved.protocolCompatibility ? { protocolCompatibility: approved.protocolCompatibility } : {}),
      });
    }
    return described;
  }

  async getNode(nodeId: string): Promise<NodeDescriptor | undefined> {
    return this.descriptorForRuntimeNode(nodeId) || (await this.listNodes()).find(node => node.id === nodeId);
  }

  async invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown> {
    const node: any = nodesManager.getNode(request.nodeId);
    if (!node || request.nodeId === 'master' || (!node.ws && !node.httpExec)) {
      throw new NodeProviderError(
        'NODE_EXECUTION_NODE_UNAVAILABLE',
        `Remote node \`${request.nodeId}\` is not connected.`,
        true,
      );
    }
    if (node.protocolCompatibility?.status === 'upgrade-required') {
      throw new NodeProviderError(
        'NODE_PROTOCOL_INCOMPATIBLE',
        `Node \`${request.nodeId}\` is connected but cannot execute tools. ${describeNodeProtocolCompatibility(node.protocolCompatibility)}`,
      );
    }
    if (!node.tools.has(request.toolName)) {
      throw new NodeProviderError(
        'NODE_EXECUTION_TOOL_UNAVAILABLE',
        `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`,
      );
    }
    if (request.owner) {
      return nodesManager.executeExternalTool(request.nodeId, request.toolName, request.args, request.owner,
        request.context.cwd, request.context.externalExec, options?.assertExternalOwnerActive);
    }
    const routingSnapshot = request.context.currentNode
      ? { currentNode: request.context.currentNode, ...(request.context.cwd !== undefined ? { cwd: request.context.cwd } : {}) }
      : undefined;
    return nodesManager.executeTool(
      request.nodeId,
      request.toolName,
      request.args,
      request.sourceSessionId,
      routingSnapshot,
      request.context.programmatic,
      options?.signal,
    );
  }

  async readFile(request: Extract<NodeToolRequest, { sourceSessionId: string }> & { toolName: 'read' }, options?: NodeProviderCallOptions): Promise<Buffer> {
    const node = nodesManager.getNode(request.nodeId);
    if (!node?.ws || node.type !== 'cli-node') {
      throw new NodeProviderError('NODE_FILE_READ_UNAVAILABLE', `Node \`${request.nodeId}\` does not support complete file reads.`);
    }
    const raw = request.args.filePath;
    if (typeof raw !== 'string' || !raw) throw new NodeProviderError('NODE_FILE_READ_INVALID_PATH', 'filePath is required.');
    // Canonical read retains the interactive CLI's approval hook. A rejected or
    // failed read must never be followed by an unapproved file transfer.
    const result: any = await this.invokeTool({ ...request, context: { ...request.context, programmatic: true } }, options);
    if (result && typeof result.content === 'string' && result.truncated === false
      && Number.isSafeInteger(result.sizeBytes) && result.sizeBytes >= 0 && result.selectedBytes === result.sizeBytes) {
      return Buffer.from(result.content, 'utf8');
    }
    const paths = result?.[RESOLVED_PATH_SIDECAR];
    const resolvedPath = typeof result?.filePath === 'string' && result.filePath
      ? result.filePath : Array.isArray(paths) && paths.length === 1 && paths[0]?.raw === raw && typeof paths[0]?.resolved === 'string'
        ? paths[0].resolved : undefined;
    let filePath = resolvedPath || raw;
    if (!resolvedPath) {
      // Older CLI peers may have neither complete content nor resolved-path
      // metadata. Preserve their native home/Agent expansion and same-Node cwd.
      const cwd = request.context.cwd;
      const targetPath = cwd && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) ? path.win32 : path.posix;
      if (cwd && targetPath === path.win32 && /^[A-Za-z]:(?:$|[^\\/])/.test(raw)
        && raw[0].toLowerCase() !== cwd[0].toLowerCase()) {
        throw new NodeProviderError('NODE_FILE_READ_AMBIGUOUS_PATH', 'Use a drive-absolute source path instead of a drive-relative path on another Windows drive.');
      }
      // Absolute/rooted paths must keep the target runtime's own drive resolution.
      if (cwd && !raw.startsWith('$') && !/^~(?:[\\/]|$)/.test(raw) && !targetPath.isAbsolute(raw)) {
        filePath = targetPath.isAbsolute(cwd) ? targetPath.resolve(cwd, raw) : targetPath.join(cwd, raw);
      }
    }
    try {
      return decodeNodeTransferFile(await nodesManager.readFileFromNode(request.nodeId, filePath, request.sourceSessionId));
    } catch (error) {
      throw new NodeProviderError('NODE_FILE_READ_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  async getDefaultCwd(request: NodeDefaultCwdRequest): Promise<string | undefined> {
    const node: any = nodesManager.getNode(request.nodeId);
    if (node?.httpExec) return node.defaultCwd;
    if (!node?.ws || !node.tools.has('get_default_cwd')) return undefined;
    try {
      const value = await nodesManager.executeTool(request.nodeId, 'get_default_cwd', {}, request.sourceSessionId);
      const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'output') : undefined;
      const raw = descriptor && 'value' in descriptor ? descriptor.value : value;
      const cwd = typeof raw === 'string' ? raw.trim() : '';
      return cwd || undefined;
    } catch {
      return undefined;
    }
  }
}

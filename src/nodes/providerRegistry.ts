import { NODE_ENVIRONMENT_BUILTIN_NAMES } from '../tools/placement';
import { nodesManager } from './manager';

export type NodeKind = 'master' | 'remote' | 'sandbox';
export type NodeAvailability = 'ready' | 'unavailable' | 'offline' | 'error';

export type NodeCapabilityDescriptor = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type NodeDescriptor = {
  id: string;
  kind: NodeKind;
  provider: string;
  type: string;
  availability: NodeAvailability;
  tools: NodeCapabilityDescriptor[];
  lastActivity?: number;
  defaultCwd?: string;
};

export type NodeToolRequest = {
  sourceSessionId: string;
  nodeId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: {
    agent: string;
    currentNode?: string;
    cwd?: string;
    deferSessionCwdSync?: boolean;
  };
};

export type NodeDefaultCwdRequest = {
  sourceSessionId: string;
  nodeId: string;
  context: { agent: string };
};

export type NodeProviderCallOptions = {
  signal?: AbortSignal;
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
  node?: NodeDescriptor;
  nodeId?: string;
  effect?: string;
  dataRetention?: string;
  details?: unknown;
};

export type NodeLifecycleProviderSummary = {
  id: string;
  actions: NodeLifecycleAction[];
};

export interface NodeProvider {
  readonly id: string;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
  /** Expensive/failure-prone discovery is consulted only when fixed in-process providers do not own the exact Node ID. */
  readonly deferredLookup?: boolean;
  listNodes(options?: NodeProviderCallOptions): Promise<NodeDescriptor[]> | NodeDescriptor[];
  getNode(nodeId: string, options?: NodeProviderCallOptions): Promise<NodeDescriptor | undefined> | NodeDescriptor | undefined;
  invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown>;
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

  constructor(providers: readonly NodeProvider[]) {
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
      for (const node of await provider.listNodes(options)) {
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
      const descriptor = await provider.getNode(nodeId, options);
      if (!descriptor) continue;
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

  async invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown> {
    const resolved = await this.resolveNode(request.nodeId, options);
    if (!resolved || resolved.descriptor.availability !== 'ready') {
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
    return resolved.provider.invokeTool(request, options);
  }

  listLifecycleProviders(): NodeLifecycleProviderSummary[] {
    return this.providers.flatMap(provider => {
      const actions: NodeLifecycleAction[] = [];
      if (provider.createNode) actions.push('create');
      if (provider.ensureNode) actions.push('ensure');
      if (provider.inspectNode) actions.push('inspect');
      if (provider.destroyNode) actions.push('destroy');
      return actions.length > 0 ? [{ id: provider.id, actions }] : [];
    });
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
    if (!method) {
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
    if (!method) {
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
      throw new NodeProviderError(
        'NODE_EXECUTION_NODE_UNAVAILABLE',
        `Node \`${request.nodeId}\` is not available.`,
        true,
      );
    }
    if (typeof resolved.descriptor.defaultCwd === 'string' && resolved.descriptor.defaultCwd.trim()) {
      return resolved.descriptor.defaultCwd.trim();
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
  readonly id = 'master';

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
  readonly id = 'authenticated-remote';

  private descriptorForRuntimeNode(nodeId: string): NodeDescriptor | undefined {
    const node: any = nodesManager.getNode(nodeId);
    if (!node || nodeId === 'master' || !node.ws) return undefined;
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
      ...(typeof node.lastActivity === 'number' ? { lastActivity: node.lastActivity } : {}),
    };
  }

  listNodes(): NodeDescriptor[] {
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
        ...(typeof activity.get(node.id) === 'number' ? { lastActivity: activity.get(node.id) } : {}),
      }));
    const known = new Set(described.map(node => node.id));
    for (const node of nodesManager.listNodes()) {
      if (node.id === 'master' || known.has(node.id)) continue;
      const descriptor = this.descriptorForRuntimeNode(node.id);
      if (descriptor) described.push(descriptor);
    }
    return described;
  }

  getNode(nodeId: string): NodeDescriptor | undefined {
    return this.descriptorForRuntimeNode(nodeId);
  }

  async invokeTool(request: NodeToolRequest): Promise<unknown> {
    const node: any = nodesManager.getNode(request.nodeId);
    if (!node || request.nodeId === 'master' || !node.ws) {
      throw new NodeProviderError(
        'NODE_EXECUTION_NODE_UNAVAILABLE',
        `Remote node \`${request.nodeId}\` is not connected.`,
        true,
      );
    }
    if (!node.tools.has(request.toolName)) {
      throw new NodeProviderError(
        'NODE_EXECUTION_TOOL_UNAVAILABLE',
        `Tool \`${request.toolName}\` not available on node \`${request.nodeId}\`.`,
      );
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
    );
  }

  async getDefaultCwd(request: NodeDefaultCwdRequest): Promise<string | undefined> {
    const node: any = nodesManager.getNode(request.nodeId);
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

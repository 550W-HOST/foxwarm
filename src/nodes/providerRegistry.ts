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

export interface NodeProvider {
  readonly id: string;
  /** Expensive/failure-prone discovery is consulted only when fixed in-process providers do not own the exact Node ID. */
  readonly deferredLookup?: boolean;
  listNodes(options?: NodeProviderCallOptions): Promise<NodeDescriptor[]> | NodeDescriptor[];
  getNode(nodeId: string, options?: NodeProviderCallOptions): Promise<NodeDescriptor | undefined> | NodeDescriptor | undefined;
  invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown>;
  getDefaultCwd?(request: NodeDefaultCwdRequest, options?: NodeProviderCallOptions): Promise<string | undefined>;
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

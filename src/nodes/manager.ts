/**
 * Nodes Manager - Manages remote nodes for distributed tool execution
 * Each node is a WebSocket connection that can execute tools
 */

import http from 'http';
import crypto from 'crypto';
import { logger } from '../common';
import { NodeTransferFilePayload, NodeTransferWriteResult, readNodeTransferFile, writeNodeTransferFile } from '../nodeFileTransfer';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { WebSocket } from 'ws';
import { isReservedNodeId } from './registry';
import { adaptLegacyRemoteNodeToolResult } from './legacyToolResultCompatibility';
import { NODE_ENVIRONMENT_BUILTIN_NAMES } from '../tools/placement';
import { issueRemoteExecCompletionCapability, verifyRemoteExecCompletionCapability } from './sessionEventCapability';
import {
  activateRemoteExecLivenessClaim,
  clearRemoteExecLivenessClaim,
  markRemoteExecOutcomeUnknown,
  releaseRemoteExecReservation,
  reserveRemoteExecIdentity,
} from './remoteExecLiveness';
import { generatePersistentExecPetname } from '../../packages/shared/dist/persistentExec';
import { PERSISTENT_EXEC_ID_COLLISION_CODE } from '../../packages/shared/dist/persistentExec';
import {
  CURRENT_NODE_PROTOCOL_RANGE,
  describeNodeProtocolCompatibility,
  negotiateNodeProtocol,
  type NodeProtocolCompatibility,
} from '../../packages/shared/dist/nodeProtocol';

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: any;
}

interface NodeCapabilities {
  tools: ToolDefinition[];
  services?: Record<string, number>;
  features?: { remoteExecBackgroundRegistration?: boolean };
}

interface Node {
  id: string;
  type: string; // 'master', 'browser-extension', 'android', etc.
  ws: WebSocket | null; // null for master node
  tools: Set<string>;
  capabilities?: NodeCapabilities; // Tool definitions for dynamic nodes
  lastActivity: number;
  protocolCompatibility: NodeProtocolCompatibility;
}

export class NodeProtocolIncompatibleError extends Error {
  readonly code = 'NODE_PROTOCOL_INCOMPATIBLE';
  readonly retryable = false;
  constructor(public readonly nodeId: string, public readonly compatibility: NodeProtocolCompatibility) {
    super(`Node \`${nodeId}\` is connected but cannot execute tools. ${describeNodeProtocolCompatibility(compatibility)}`);
    this.name = 'NodeProtocolIncompatibleError';
  }
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  sessionId: string;
  node: string;
  remoteExec?: {
    originalSessionId: string;
    execId: string;
    completionCapability: string;
    supportsBackgroundRegistration: boolean;
  };
  resolve: (result: any) => void;
  reject: (error: unknown) => void;
}

const LEGACY_PERSISTENT_EXEC_INVALID_ID_ERROR = 'Persistent exec ID is invalid.';

function exactRemoteErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function legacyPersistentExecCollisionMessage(execId: string): string {
  return `Persistent exec \`${execId}\` already exists.`;
}

function remoteErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function remoteExecStarted(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'execStarted');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'boolean'
    ? descriptor.value
    : undefined;
}

interface PendingFileTransfer<T = any> {
  id: string;
  nodeId: string;
  sessionId: string;
  type: 'read' | 'write';
  resolve: (result: T) => void;
  reject: (error: string) => void;
}

interface PendingServiceRequest {
  id: string;
  nodeId: string;
  service: string;
  operation: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export type NodeServiceEvent = { nodeId: string; service: string; event: any };

export class NodeServiceRequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'NodeServiceRequestError';
  }
}

export class NodesManager {
  private nodes: Map<string, Node> = new Map();
  private toolCalls: Map<string, ToolCall> = new Map();
  private fileTransfers: Map<string, PendingFileTransfer> = new Map();
  private serviceRequests: Map<string, PendingServiceRequest> = new Map();
  private serviceEventListeners = new Set<(event: NodeServiceEvent) => void>();
  private tools: Set<string> = new Set(); // Available tools
  
  constructor(private readonly runtimeOptions: { generateExecId?: () => string; remoteExecCollisionAttempts?: number } = {}) {
    this.setupTools();
    this.registerMasterNode();
  }

  private setupTools() {
    this.tools = new Set(NODE_ENVIRONMENT_BUILTIN_NAMES);
  }

  /**
   * Register master node (local execution)
   */
  private registerMasterNode(): void {
    const masterNode: Node = {
      id: 'master',
      type: 'master',
      ws: null, // Master doesn't use WebSocket
      tools: new Set(this.tools),
      lastActivity: Date.now(),
      protocolCompatibility: negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE),
    };
    
    this.nodes.set('master', masterNode);
    logger.info('Master node registered');
  }

  /**
   * Register a new node
   */
  registerNode(ws: WebSocket, _req: http.IncomingMessage, customNodeId?: string): string {
    if (customNodeId && isReservedNodeId(customNodeId)) {
      throw new Error(`Node id \`${customNodeId}\` is reserved`);
    }
    const nodeId = customNodeId || `node_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    
    // Check if node already exists (reconnection case)
    const existingNode = this.nodes.get(nodeId);
    if (existingNode && existingNode.ws && existingNode.ws !== ws) {
      logger.info({ nodeId }, 'Node reconnecting, closing old connection');
      existingNode.ws.close();
    }
    
    const node: Node = {
      id: nodeId,
      type: 'legacy', // Legacy node without capabilities
      ws,
      tools: new Set(this.tools),
      lastActivity: Date.now(),
      protocolCompatibility: negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE),
    };
    
    this.nodes.set(nodeId, node);
    logger.info({ nodeId }, 'Node registered');
    
    // Send node ID to the node
    ws.send(JSON.stringify({
      type: 'registered',
      nodeId: nodeId
    }));
    
    return nodeId;
  }

  /**
   * Register a new node with capabilities (dynamic tools)
   */
  registerNodeWithTools(
    ws: WebSocket,
    _req: http.IncomingMessage,
    nodeType: string,
    capabilities: NodeCapabilities,
    customNodeId?: string,
    protocolCompatibility: NodeProtocolCompatibility = negotiateNodeProtocol(CURRENT_NODE_PROTOCOL_RANGE),
  ): string {
    if (protocolCompatibility.status !== 'compatible') {
      throw new Error('Compatible Node registration requires an intersecting core protocol.');
    }
    return this.registerRemoteNodeWithTools(ws, nodeType, capabilities, protocolCompatibility, customNodeId, true);
  }

  registerIncompatibleNodeWithTools(
    ws: WebSocket,
    _req: http.IncomingMessage,
    nodeType: string,
    capabilities: NodeCapabilities,
    compatibility: NodeProtocolCompatibility,
    customNodeId?: string,
  ): string {
    if (compatibility.status !== 'upgrade-required') {
      throw new Error('Protocol quarantine requires a non-intersecting core protocol.');
    }
    return this.registerRemoteNodeWithTools(ws, nodeType, capabilities, compatibility, customNodeId, false);
  }

  private registerRemoteNodeWithTools(
    ws: WebSocket,
    nodeType: string,
    capabilities: NodeCapabilities,
    protocolCompatibility: NodeProtocolCompatibility,
    customNodeId: string | undefined,
    executable: boolean,
  ): string {
    if (customNodeId && isReservedNodeId(customNodeId)) {
      throw new Error(`Node id \`${customNodeId}\` is reserved`);
    }
    const nodeId = customNodeId || `node_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    
    // Check if node already exists (reconnection case)
    const existingNode = this.nodes.get(nodeId);
    if (existingNode && existingNode.ws && existingNode.ws !== ws) {
      logger.info({ nodeId }, 'Node reconnecting, closing old connection');
      existingNode.ws.close();
    }
    
    // Extract tool names from capabilities
    const toolNames = new Set(capabilities.tools.map(t => t.name));
    
    const node: Node = {
      id: nodeId,
      type: nodeType,
      ws,
      tools: toolNames,
      capabilities,
      lastActivity: Date.now(),
      protocolCompatibility,
    };
    
    this.nodes.set(nodeId, node);
    logger.info({ nodeId, nodeType, toolCount: toolNames.size, protocolCompatibility }, executable
      ? 'Node registered with compatible capabilities'
      : 'Node connected in protocol-incompatible quarantine');
    
    // Send node ID to the node
    if (executable) {
      ws.send(JSON.stringify({
        type: 'registered',
        nodeId: nodeId,
        status: 'success',
        nodeProtocol: {
          negotiated: protocolCompatibility.negotiated,
          master: protocolCompatibility.master,
        },
      }));
    } else {
      const message = describeNodeProtocolCompatibility(protocolCompatibility);
      ws.send(JSON.stringify({
        type: 'node_incompatible',
        code: 'NODE_PROTOCOL_INCOMPATIBLE',
        nodeId,
        clientProtocol: protocolCompatibility.client,
        masterProtocol: protocolCompatibility.master,
        legacyClient: protocolCompatibility.legacyClient,
        message,
      }));
      // Legacy clients do not know node_incompatible but do log ordinary errors.
      ws.send(JSON.stringify({ type: 'error', code: 'NODE_PROTOCOL_INCOMPATIBLE', error: message }));
    }
    
    return nodeId;
  }

  /**
   * Unregister a node
   */
  unregisterNode(nodeId: string, ws?: WebSocket | null): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      if (ws && node.ws && node.ws !== ws) {
        logger.info({ nodeId }, 'Skipping unregister for stale node connection');
        return;
      }
      this.emitNodeServicesUnavailable(node, 'Remote node disconnected.');
      this.nodes.delete(nodeId);
      logger.info({ nodeId }, 'Node unregistered');
    }
  }

  /**
   * Disconnect and unregister a remote node immediately.
   * Used when persistent credentials are removed or moved so stale runtime
   * WebSocket state cannot continue to execute tools under the old id.
   */
  disconnectNode(nodeId: string, reason = 'Node disconnected by server'): boolean {
    if (nodeId === 'master') {
      throw new Error('Cannot disconnect master node');
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }

    this.rejectPendingOperationsForNode(nodeId, reason);
    this.emitNodeServicesUnavailable(node, reason);
    this.nodes.delete(nodeId);

    if (node.ws) {
      try {
        node.ws.close(1008, reason);
      } catch (err) {
        logger.warn({ err, nodeId }, 'Failed to close node WebSocket cleanly; terminating');
        try {
          node.ws.terminate();
        } catch {}
      }
    }

    logger.info({ nodeId, reason }, 'Node disconnected and unregistered');
    return true;
  }

  private rejectPendingOperationsForNode(nodeId: string, reason: string): void {
    for (const [callId, call] of this.toolCalls.entries()) {
      if (call.node !== nodeId) continue;
      this.toolCalls.delete(callId);
      if (call.remoteExec) {
        markRemoteExecOutcomeUnknown({
          authenticatedNodeId: call.node,
          originalSessionId: call.remoteExec.originalSessionId,
          execId: call.remoteExec.execId,
          completionCapability: call.remoteExec.completionCapability,
        });
      }
      call.reject(reason);
    }

    for (const [transferId, transfer] of this.fileTransfers.entries()) {
      if (transfer.nodeId !== nodeId) continue;
      this.fileTransfers.delete(transferId);
      transfer.reject(reason);
    }

    for (const [requestId, request] of this.serviceRequests.entries()) {
      if (request.nodeId !== nodeId) continue;
      this.serviceRequests.delete(requestId);
      clearTimeout(request.timeout);
      request.reject(new NodeServiceRequestError('NodeUnavailable', reason, 503));
    }
  }

  private emitNodeServicesUnavailable(node: Node, reason: string): void {
    for (const service of Object.keys(node.capabilities?.services || {})) {
      for (const listener of this.serviceEventListeners) {
        try { listener({ nodeId: node.id, service, event: { type: 'node-unavailable', reason } }); }
        catch (error) { logger.warn({ err: error, nodeId: node.id, service }, 'Node service disconnect listener failed'); }
      }
    }
  }

  /**
   * Get current node for a session
   */
  async getCurrentNode(sessionId: string): Promise<string | null> {
    const session = sessionManager.getSessionCatalog(sessionId);
    if (!session) return null;
    return session.currentNode || null;
  }

  /**
   * Set current node for a session (validation only, actual setting done in commandHandler)
   */
  setCurrentNode(sessionId: string, nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node && nodeId !== 'master') {
      throw new Error(`Node \`${nodeId}\` not found`);
    }
    if (node) this.assertNodeProtocolCompatible(node);
    
    logger.info({ sessionId, nodeId }, 'Current node validated');
  }

  /**
   * Get node by ID
   */
  getNode(nodeId: string): Node | undefined {
    return this.nodes.get(nodeId);
  }

  private assertNodeProtocolCompatible(node: Node): void {
    if (node.protocolCompatibility?.status === 'upgrade-required') {
      throw new NodeProtocolIncompatibleError(node.id, node.protocolCompatibility);
    }
  }

  private assertConnectedNodeProtocolCompatible(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) this.assertNodeProtocolCompatible(node);
  }

  /**
   * List all nodes
   */
  listNodes(): Array<{ id: string; lastActivity: number; protocolCompatibility: NodeProtocolCompatibility }> {
    return Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      lastActivity: node.lastActivity,
      protocolCompatibility: node.protocolCompatibility,
    }));
  }

  /**
   * List all nodes with their tool capabilities
   */
  listNodesWithTools(): Array<{ id: string; type: string; tools: ToolDefinition[] }> {
    return Array.from(this.nodes.values())
      .filter((node) => (node.type === 'master' || node.capabilities) && node.protocolCompatibility?.status !== 'upgrade-required')
      .map((node) => ({
        id: node.id,
        type: node.type,
        tools: node.type === 'master'
          ? [...node.tools].map(name => this.getToolDefinition(name)).filter(Boolean)
          : (node.capabilities?.tools || [])
      }));
  }

  listNodeServiceSummaries(): Array<{ id: string; type: string; services: Record<string, number>; lastActivity: number; protocolCompatibility: NodeProtocolCompatibility }> {
    return Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      type: node.type,
      services: node.protocolCompatibility?.status !== 'upgrade-required' ? { ...(node.capabilities?.services || {}) } : {},
      lastActivity: node.lastActivity,
      protocolCompatibility: node.protocolCompatibility,
    }));
  }

  listNodeIdsWithService(service: string): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.id !== 'master' && !!node.ws && Number(node.capabilities?.services?.[service] || 0) >= 1)
      .filter((node) => node.protocolCompatibility?.status !== 'upgrade-required')
      .map((node) => node.id);
  }

  onNodeServiceEvent(listener: (event: NodeServiceEvent) => void): () => void {
    this.serviceEventListeners.add(listener);
    return () => this.serviceEventListeners.delete(listener);
  }

  handleNodeServiceEvent(nodeId: string, service: string, event: any): void {
    const node = this.nodes.get(nodeId);
    if (!node || node.protocolCompatibility?.status === 'upgrade-required' || Number(node.capabilities?.services?.[service] || 0) < 1) {
      logger.warn({ nodeId, service }, 'Ignoring event for an unadvertised node service');
      return;
    }
    for (const listener of this.serviceEventListeners) {
      try { listener({ nodeId, service, event }); }
      catch (error) { logger.warn({ err: error, nodeId, service }, 'Node service event listener failed'); }
    }
  }

  async requestNodeService(nodeId: string, service: string, operation: string, args: Record<string, unknown>, timeoutMs = 30_000, minimumVersion = 1): Promise<any> {
    const node = this.nodes.get(nodeId);
    if (!node || nodeId === 'master' || !node.ws) {
      throw new NodeServiceRequestError('NodeUnavailable', `Remote node \`${nodeId}\` is not connected.`, 503);
    }
    this.assertNodeProtocolCompatible(node);
    const version = node.capabilities?.services?.[service];
    if (!Number.isInteger(version) || Number(version) < minimumVersion) {
      const requirement = minimumVersion > 1 ? ` version ${minimumVersion} or newer` : '';
      throw new NodeServiceRequestError('UnsupportedService', `Node \`${nodeId}\` does not advertise service \`${service}\`${requirement}.`, 501);
    }
    const requestId = `service_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.serviceRequests.has(requestId)) return;
        this.serviceRequests.delete(requestId);
        reject(new NodeServiceRequestError('NodeTimeout', `Node service request \`${requestId}\` timed out.`, 504));
      }, timeoutMs);
      this.serviceRequests.set(requestId, { id: requestId, nodeId, service, operation, resolve, reject, timeout });
      try {
        node.ws!.send(JSON.stringify({ type: 'node_service_request', requestId, service, operation, args }));
      } catch (error) {
        this.serviceRequests.delete(requestId);
        clearTimeout(timeout);
        reject(new NodeServiceRequestError('NodeUnavailable', error instanceof Error ? error.message : String(error), 503));
      }
    });
  }

  sendNodeServiceCommand(nodeId: string, service: string, operation: string, args: Record<string, unknown>): void {
    const node = this.nodes.get(nodeId);
    if (!node || nodeId === 'master' || !node.ws) {
      throw new NodeServiceRequestError('NodeUnavailable', `Remote node \`${nodeId}\` is not connected.`, 503);
    }
    this.assertNodeProtocolCompatible(node);
    if (Number(node.capabilities?.services?.[service] || 0) < 1) {
      throw new NodeServiceRequestError('UnsupportedService', `Node \`${nodeId}\` does not advertise service \`${service}\`.`, 501);
    }
    node.ws.send(JSON.stringify({ type: 'node_service_command', service, operation, args }));
  }

  handleNodeServiceResponse(nodeId: string, requestId: string, result: any): void {
    const request = this.serviceRequests.get(requestId);
    if (!request || request.nodeId !== nodeId) {
      logger.warn({ nodeId, requestId }, 'Node service response for unknown request');
      return;
    }
    this.serviceRequests.delete(requestId);
    clearTimeout(request.timeout);
    request.resolve(result);
  }

  handleNodeServiceError(nodeId: string, requestId: string, error: { code?: string; message?: string; statusCode?: number } | string): void {
    const request = this.serviceRequests.get(requestId);
    if (!request || request.nodeId !== nodeId) {
      logger.warn({ nodeId, requestId }, 'Node service error for unknown request');
      return;
    }
    this.serviceRequests.delete(requestId);
    clearTimeout(request.timeout);
    const payload = typeof error === 'string' ? { message: error } : error;
    request.reject(new NodeServiceRequestError(payload.code || 'NodeServiceError', payload.message || 'Node service failed.', payload.statusCode || 500));
  }

  /**
   * Execute a tool on a specific node
   */
  async executeNodeTool(nodeId: string, toolName: string, args: Record<string, any>, sessionId: string): Promise<any> {
    return await this.executeTool(nodeId, toolName, args, sessionId);
  }

  /**
   * Execute a tool on a node
   */
  async executeTool(
    nodeId: string,
    toolName: string,
    args: Record<string, any>,
    sessionId: string,
    routingSnapshot?: { currentNode: string; cwd?: string },
  ): Promise<any> {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node \`${nodeId}\` not found`);
    }
    this.assertNodeProtocolCompatible(node);

    const session = sessionManager.getSessionCatalog(sessionId);
    if (!session) throw new Error(`Session \`${sessionId}\` not found`);
    
    if (!node.tools.has(toolName)) {
      throw new Error(`Tool \`${toolName}\` not available on node \`${nodeId}\``);
    }
    
    // If master node, execute locally
    if (nodeId === 'master') {
      return await this.executeToolLocally(toolName, args, sessionId);
    }
    
    const sourceSessionId = session.id;
    const sourceIdentityIds = [sourceSessionId, ...(session.aliases || [])];
    const executeRemoteOnce = (remoteExec?: {
      originalSessionId: string;
      execId: string;
      completionCapability: string;
      supportsBackgroundRegistration: boolean;
    }): Promise<any> => new Promise((resolve, reject) => {
      const callId = `call_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
      const toolCall: ToolCall = {
        id: callId,
        name: toolName,
        args,
        sessionId: sourceSessionId,
        node: nodeId,
        remoteExec,
        resolve,
        reject
      };
      
      this.toolCalls.set(callId, toolCall);
      
      // Send tool call to node
      // Only send sessionCwd when the session's currentNode matches the target node.
      // When using call_tool to temporarily execute on a remote node, session.cwd
      // is a master-local path and should not be forwarded.
      const routedCurrentNode = routingSnapshot?.currentNode || session.currentNode;
      const routedCwd = routingSnapshot ? routingSnapshot.cwd : session.cwd;
      const shouldSendCwd = routedCurrentNode === nodeId && typeof routedCwd === 'string';
      const timeoutMs = 62000;
      try {
        node.ws!.send(JSON.stringify({
          type: 'tool_call',
          callId: callId,
          tool: toolName,
          args: args,
          sessionId: sourceSessionId,
          agentName: session.agent || 'main',
          timeoutMs,
          ...(remoteExec ? { backgroundExecId: remoteExec.execId, completionCapability: remoteExec.completionCapability } : {}),
          ...(shouldSendCwd ? { sessionCwd: routedCwd } : {}),
        }));
      } catch (error) {
        this.toolCalls.delete(callId);
        if (remoteExec) {
          releaseRemoteExecReservation({
            authenticatedNodeId: nodeId,
            originalSessionId: remoteExec.originalSessionId,
            execId: remoteExec.execId,
            completionCapability: remoteExec.completionCapability,
          });
        }
        reject(error);
        return;
      }
      
      // Set timeout
      const timeout = setTimeout(() => {
        if (this.toolCalls.has(callId)) {
          this.toolCalls.delete(callId);
          if (remoteExec) {
            markRemoteExecOutcomeUnknown({
              authenticatedNodeId: nodeId,
              originalSessionId: remoteExec.originalSessionId,
              execId: remoteExec.execId,
              completionCapability: remoteExec.completionCapability,
            });
          }
          reject(`Tool call \`${callId}\` timed out`);
        }
      }, timeoutMs);
      timeout.unref?.();
    });
    if (toolName !== 'exec') return await executeRemoteOnce();
    const maxAttempts = this.runtimeOptions.remoteExecCollisionAttempts || 16;
    const reserveIdentity = (execId: string) => {
      const completionCapability = issueRemoteExecCompletionCapability(nodeId, sourceSessionId, execId);
      const reserved = reserveRemoteExecIdentity({
        authenticatedNodeId: nodeId,
        canonicalSessionId: sourceSessionId,
        sessionIdentityIds: sourceIdentityIds,
        agentName: session.agent || 'main',
        execId,
        completionCapability,
      });
      return reserved ? {
        originalSessionId: sourceSessionId,
        execId,
        completionCapability,
        supportsBackgroundRegistration: node.capabilities?.features?.remoteExecBackgroundRegistration === true,
      } : undefined;
    };
    if (node.protocolCompatibility?.negotiated === 1) {
      let requiresLegacyPrefix = false;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const currentExecId = this.runtimeOptions.generateExecId?.() || generatePersistentExecPetname();
        const remoteExec = reserveIdentity(currentExecId);
        if (!remoteExec) continue;
        try { return await executeRemoteOnce(remoteExec); }
        catch (error) {
          if (exactRemoteErrorMessage(error) !== LEGACY_PERSISTENT_EXEC_INVALID_ID_ERROR) throw error;
          requiresLegacyPrefix = true;
          break;
        }
      }
      if (!requiresLegacyPrefix) {
        throw new Error(`Remote persistent exec ID allocation exhausted after ${maxAttempts} Main-reservation collision retries.`);
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const legacyExecId = `exec_${this.runtimeOptions.generateExecId?.() || generatePersistentExecPetname()}`;
        const remoteExec = reserveIdentity(legacyExecId);
        if (!remoteExec) continue;
        try { return await executeRemoteOnce(remoteExec); }
        catch (error) {
          if (exactRemoteErrorMessage(error) !== legacyPersistentExecCollisionMessage(legacyExecId)) throw error;
        }
      }
      throw new Error(`Remote legacy persistent exec ID allocation exhausted after ${maxAttempts} owner-acknowledged collision retries.`);
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const backgroundExecId = this.runtimeOptions.generateExecId?.() || generatePersistentExecPetname();
      const remoteExec = reserveIdentity(backgroundExecId);
      if (!remoteExec) continue;
      try { return await executeRemoteOnce(remoteExec); }
      catch (error: any) {
        if (error?.code !== PERSISTENT_EXEC_ID_COLLISION_CODE) throw error;
      }
    }
    throw new Error(`Remote persistent exec ID allocation exhausted after ${maxAttempts} owner-acknowledged collision retries.`);
  }

  /**
   * Handle tool response from node
   */
  handleToolResponse(callId: string, result: any): void {
    const call = this.toolCalls.get(callId);
    if (call) {
      this.toolCalls.delete(callId);
      if (call.remoteExec) {
        const identity = {
          authenticatedNodeId: call.node,
          originalSessionId: call.remoteExec.originalSessionId,
          execId: call.remoteExec.execId,
          completionCapability: call.remoteExec.completionCapability,
        };
        if (call.remoteExec.supportsBackgroundRegistration) {
          releaseRemoteExecReservation(identity);
        } else {
          markRemoteExecOutcomeUnknown(identity);
        }
      }
      call.resolve(adaptLegacyRemoteNodeToolResult(result));
      logger.info({ callId, tool: call.name }, 'Tool response received');
    } else {
      logger.warn({ callId }, 'Tool response for unknown call');
    }
  }

  /**
   * Handle tool error from node
   */
  handleToolError(callId: string, error: unknown, reportedExecStarted?: boolean): void {
    const call = this.toolCalls.get(callId);
    if (call) {
      this.toolCalls.delete(callId);
      if (call.remoteExec) {
        const identity = {
          authenticatedNodeId: call.node,
          originalSessionId: call.remoteExec.originalSessionId,
          execId: call.remoteExec.execId,
          completionCapability: call.remoteExec.completionCapability,
        };
        const started = reportedExecStarted ?? remoteExecStarted(error);
        const isDefinitePreStart = started === false || (started === undefined && (
          remoteErrorCode(error) === PERSISTENT_EXEC_ID_COLLISION_CODE
          || exactRemoteErrorMessage(error) === LEGACY_PERSISTENT_EXEC_INVALID_ID_ERROR
          || exactRemoteErrorMessage(error) === legacyPersistentExecCollisionMessage(call.remoteExec.execId)
        ));
        if (isDefinitePreStart) releaseRemoteExecReservation(identity);
        else markRemoteExecOutcomeUnknown(identity);
      }
      call.reject(error);
      logger.warn({ callId, tool: call.name, error }, 'Tool error received');
    } else {
      logger.warn({ callId }, 'Tool error for unknown call');
    }
  }

  async readFileFromNode(nodeId: string, filePath: string, sessionId: string): Promise<NodeTransferFilePayload> {
    const session = sessionManager.getSessionCatalog(sessionId);
    if (!session) throw new Error(`Session \`${sessionId}\` not found`);
    const agentName = session.agent || 'main';
    const restrictToAgentDir = sessionManager.isSessionEffectivelyIsolated(session) && nodeId === 'master';

    if (nodeId === 'master') {
      return await readNodeTransferFile(filePath, agentName, restrictToAgentDir);
    }

    const node = this.nodes.get(nodeId);
    if (!node?.ws) {
      throw new Error(`Node \`${nodeId}\` not found`);
    }
    this.assertNodeProtocolCompatible(node);

    const transferId = `file_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    return new Promise((resolve, reject) => {
      this.fileTransfers.set(transferId, {
        id: transferId,
        nodeId,
        sessionId,
        type: 'read',
        resolve,
        reject,
      });

      node.ws!.send(JSON.stringify({
        type: 'file_read_request',
        transferId,
        filePath,
        sessionId,
        agentName,
        restrictToAgentDir,
      }));

      setTimeout(() => {
        if (this.fileTransfers.has(transferId)) {
          this.fileTransfers.delete(transferId);
          reject(`File read \`${transferId}\` timed out`);
        }
      }, 30000);
    });
  }

  async writeFileToNode(nodeId: string, filePath: string, dataBase64: string, overwrite: boolean, sessionId: string): Promise<NodeTransferWriteResult> {
    const session = sessionManager.getSessionCatalog(sessionId);
    if (!session) throw new Error(`Session \`${sessionId}\` not found`);
    const agentName = session.agent || 'main';
    const restrictToAgentDir = sessionManager.isSessionEffectivelyIsolated(session) && nodeId === 'master';

    if (nodeId === 'master') {
      return await writeNodeTransferFile(filePath, agentName, dataBase64, overwrite, restrictToAgentDir);
    }

    const node = this.nodes.get(nodeId);
    if (!node?.ws) {
      throw new Error(`Node \`${nodeId}\` not found`);
    }
    this.assertNodeProtocolCompatible(node);

    const transferId = `file_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    return new Promise((resolve, reject) => {
      this.fileTransfers.set(transferId, {
        id: transferId,
        nodeId,
        sessionId,
        type: 'write',
        resolve,
        reject,
      });

      node.ws!.send(JSON.stringify({
        type: 'file_write_request',
        transferId,
        filePath,
        dataBase64,
        overwrite,
        sessionId,
        agentName,
        restrictToAgentDir,
      }));

      setTimeout(() => {
        if (this.fileTransfers.has(transferId)) {
          this.fileTransfers.delete(transferId);
          reject(`File write \`${transferId}\` timed out`);
        }
      }, 30000);
    });
  }

  handleFileReadResponse(transferId: string, file: NodeTransferFilePayload): void {
    const transfer = this.fileTransfers.get(transferId);
    if (!transfer) {
      logger.warn({ transferId }, 'File read response for unknown transfer');
      return;
    }
    this.fileTransfers.delete(transferId);
    transfer.resolve(file);
    logger.info({ transferId, nodeId: transfer.nodeId }, 'File read response received');
  }

  handleFileWriteResponse(transferId: string, result: NodeTransferWriteResult): void {
    const transfer = this.fileTransfers.get(transferId);
    if (!transfer) {
      logger.warn({ transferId }, 'File write response for unknown transfer');
      return;
    }
    this.fileTransfers.delete(transferId);
    transfer.resolve(result);
    logger.info({ transferId, nodeId: transfer.nodeId }, 'File write response received');
  }

  handleFileTransferError(transferId: string, error: string): void {
    const transfer = this.fileTransfers.get(transferId);
    if (!transfer) {
      logger.warn({ transferId }, 'File transfer error for unknown transfer');
      return;
    }
    this.fileTransfers.delete(transferId);
    transfer.reject(error);
    logger.warn({ transferId, nodeId: transfer.nodeId, error }, 'File transfer error received');
  }

  private async assertNodeOwnsSessionForEvent(nodeId: string, sessionId: string): Promise<void> {
    const session = await sessionRuntime.getSession(sessionId);
    if (!session) {
      throw new Error(`Target session "${sessionId}" not found.`);
    }

    if (session.currentNode === nodeId) {
      return;
    }

    const agentName = session.agent || 'main';
    if (sessionManager.isAgentIsolated(agentName) && sessionManager.getAgentIsolationNode(agentName) === nodeId) {
      return;
    }

    throw new Error(`Node "${nodeId}" cannot send session events to "${sessionId}" because the session is not assigned to that node or its isolated agent.`);
  }

  private nodeCanAccessSession(nodeId: string, session: any): boolean {
    if (session.currentNode === nodeId) {
      return true;
    }

    const agentName = session.agent || 'main';
    return sessionManager.isAgentIsolated(agentName) && sessionManager.getAgentIsolationNode(agentName) === nodeId;
  }

  private async assertNodeCanAccessSession(nodeId: string, sessionId: string, action: string): Promise<any> {
    const session = await sessionRuntime.getSession(sessionId);
    if (!session) {
      throw new Error(`Target session "${sessionId}" not found.`);
    }

    if (this.nodeCanAccessSession(nodeId, session)) {
      return session;
    }

    throw new Error(`Node "${nodeId}" cannot ${action} session "${sessionId}" because the session is not assigned to that node or its isolated agent.`);
  }

  private summarizeSession(session: any) {
    return {
      id: session.id,
      displayName: session.displayName,
      messageCount: session.messageCount ?? session.meta?.messageCount ?? session.history?.length ?? 0,
      lastMessageTime: session.lastMessageTime ?? session.meta?.lastMessageTime ?? null,
      currentNode: session.currentNode,
      cwd: session.cwd,
      busy: session.busy,
      queueLength: session.queueLength ?? session.queue?.length ?? 0,
    };
  }

  private messagePartToText(part: any): string {
    if (!part || typeof part !== 'object') {
      return String(part ?? '');
    }
    if (typeof part.text === 'string') return part.text;
    if (typeof part.system === 'string') return `[SYSTEM] ${part.system}`;
    if (part.inlineData) return `[inline data: ${part.inlineData.mimeType || 'unknown'}]`;
    if (part.functionCall) return `[tool call: ${part.functionCall.name || 'unknown'} ${JSON.stringify(part.functionCall.args || {})}]`;
    if (part.functionResponse) return `[tool response: ${part.functionResponse.name || 'unknown'} ${JSON.stringify(part.functionResponse.response || {})}]`;
    return JSON.stringify(part);
  }

  private serializeSessionMessage(message: any, index: number) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return {
      index,
      role: message.role || 'unknown',
      text: parts.map((part: any) => this.messagePartToText(part)).filter(Boolean).join('\n'),
      timestamp: message.__meta?.timestamp,
    };
  }

  async listSessionsForNode(nodeId: string) {
    this.assertConnectedNodeProtocolCompatible(nodeId);
    const summaries = [];
    for (const session of await sessionRuntime.listSessions()) {
      if (this.nodeCanAccessSession(nodeId, session)) summaries.push(this.summarizeSession(session));
    }
    return summaries;
  }

  async getSessionHistoryForNode(nodeId: string, sessionId: string, count = 30) {
    this.assertConnectedNodeProtocolCompatible(nodeId);
    const catalogSession = await this.assertNodeCanAccessSession(nodeId, sessionId, 'read history for');
    const runtimeSession = await sessionRuntime.getSession(catalogSession.id);
    if (!runtimeSession || !this.nodeCanAccessSession(nodeId, runtimeSession)) {
      throw new Error(`Node "${nodeId}" cannot read history for session "${sessionId}" because the session assignment changed.`);
    }
    const snapshot = await sessionRuntime.getHistory(catalogSession.id);
    if (!snapshot) throw new Error(`Target session "${sessionId}" not found.`);
    const totalMessages = snapshot.messages.length;
    const safeCount = Math.max(1, Math.min(100, Number(count) || 30));
    const start = Math.max(0, totalMessages - safeCount);
    const messages = snapshot.messages.slice(start, start + safeCount);
    return {
      session: this.summarizeSession(snapshot.session),
      totalMessages,
      messages: messages.map((message, offset) => this.serializeSessionMessage(message, start + offset)),
    };
  }

  async handleSessionEvent(
    nodeId: string,
    sessionId: string,
    message: string,
    type: 'background' | 'trigger' | 'onboot' = 'background',
    metadata: { eventId?: string; execId?: string; completionCapability?: string; eventTimestamp?: number } = {},
  ): Promise<void> {
    this.assertConnectedNodeProtocolCompatible(nodeId);
    const hasCompletionMetadata = !!(
      metadata.eventId
      || metadata.execId
      || metadata.completionCapability
      || metadata.eventTimestamp !== undefined
    );
    if (hasCompletionMetadata) {
      if (type !== 'background'
        || !metadata.execId
        || !metadata.completionCapability
        || metadata.eventId !== `remote-exec-completion:${metadata.execId}`
        || !verifyRemoteExecCompletionCapability(metadata.completionCapability, { nodeId, sessionId, execId: metadata.execId })) {
        throw new Error(`Node "${nodeId}" supplied an invalid remote exec completion capability for session "${sessionId}".`);
      }
      if (!sessionManager.getSessionCatalog(sessionId)) {
        throw new Error(`Remote exec completion target session "${sessionId}" was not found.`);
      }
    } else {
      await this.assertNodeOwnsSessionForEvent(nodeId, sessionId);
    }
    await sessionManager.queueSessionSystemEvent(
      sessionId,
      message,
      type,
      metadata.eventId,
      Number.isFinite(metadata.eventTimestamp) ? metadata.eventTimestamp : undefined,
      metadata.execId,
    );
    if (metadata.execId && metadata.completionCapability) {
      clearRemoteExecLivenessClaim({
        authenticatedNodeId: nodeId,
        originalSessionId: sessionId,
        execId: metadata.execId,
        completionCapability: metadata.completionCapability,
      });
    }
    logger.info({ nodeId, sessionId, type, eventId: metadata.eventId, execId: metadata.execId }, 'Session event received from remote node');
  }

  registerRemoteExecBackground(nodeId: string, input: {
    sessionId: string;
    execId: string;
    completionCapability: string;
  }): void {
    this.assertConnectedNodeProtocolCompatible(nodeId);
    if (!sessionManager.getSessionCatalog(input.sessionId)) {
      throw new Error(`Node "${nodeId}" supplied invalid remote exec liveness ownership for session "${input.sessionId}".`);
    }
    activateRemoteExecLivenessClaim({
      authenticatedNodeId: nodeId,
      originalSessionId: input.sessionId,
      execId: input.execId,
      completionCapability: input.completionCapability,
    });
    logger.info({ nodeId, sessionId: input.sessionId, execId: input.execId }, 'Remote background exec liveness registered');
  }

  async handleSessionUserMessage(nodeId: string, sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'trigger'): Promise<void> {
    this.assertConnectedNodeProtocolCompatible(nodeId);
    await this.assertNodeCanAccessSession(nodeId, sessionId, 'send messages to');
    await sessionManager.queueSessionEvent(sessionId, message, type);
    logger.info({ nodeId, sessionId, type }, 'Session user message received from remote node');
  }

  /**
   * Update node activity
   */
  updateNodeActivity(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastActivity = Date.now();
    }
  }

  /**
   * Get tool definition
   */
  getToolDefinition(toolName: string): any {
    // Keep lazy require here to avoid a real circular dependency:
    // tools -> nodesManager -> tools.
    const toolsModule = require('../tools');
    const definitions = toolsModule.definitions;
    
    return definitions.find((d: any) => d.name === toolName);
  }

  /**
   * Execute a tool locally (on master node)
   */
  async executeToolLocally(toolName: string, args: Record<string, any>, sessionId: string): Promise<any> {
    // Keep lazy require here to avoid a real circular dependency:
    // tools -> nodesManager -> tools.
    const toolsModule = require('../tools');
    const tool = toolsModule[toolName];
    const runtimeNodeId = typeof args?.__runtimeNodeId === 'string' && args.__runtimeNodeId.trim().length > 0
      ? args.__runtimeNodeId.trim()
      : 'master';
    const toolArgs = { ...(args || {}) };
    delete toolArgs.__runtimeNodeId;
    
    if (!tool) {
      throw new Error(`Tool \`${toolName}\` not found`);
    }
    
    const ctx = {
      sessionId,
      session: await sessionManager.getSession(sessionId),
      runtimeNodeId,
      broadcast: async (text: string) => {
        // Broadcast via session
        const session = await sessionManager.getSession(sessionId);
        if (session.broadcast) {
          session.broadcast(text);
        }
      }
    };
    
    return await tool(toolArgs, ctx);
  }
}

// Create singleton instance
export const nodesManager = new NodesManager();
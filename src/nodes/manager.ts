/**
 * Nodes Manager - Manages remote nodes for distributed tool execution
 * Each node is a WebSocket connection that can execute tools
 */

import http from 'http';
import crypto from 'crypto';
import { logger } from '../common';
import { NodeTransferFilePayload, NodeTransferWriteResult, readNodeTransferFile, writeNodeTransferFile } from '../nodeFileTransfer';
import * as sessionManager from '../sessionManager';
import { WebSocket } from 'ws';
import { isReservedNodeId } from './registry';
import { adaptLegacyRemoteNodeToolResult } from './legacyToolResultCompatibility';

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: any;
}

interface NodeCapabilities {
  tools: ToolDefinition[];
  services?: Record<string, number>;
}

interface Node {
  id: string;
  type: string; // 'master', 'browser-extension', 'android', etc.
  ws: WebSocket | null; // null for master node
  tools: Set<string>;
  capabilities?: NodeCapabilities; // Tool definitions for dynamic nodes
  lastActivity: number;
}

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  sessionId: string;
  node: string;
  resolve: (result: any) => void;
  reject: (error: string) => void;
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
  
  constructor() {
    this.setupTools();
    this.registerMasterNode();
  }

  private setupTools() {
    // Register available tools
    this.tools = new Set([
      'read',
      'write',
      'edit',
      'read_memory',
      'write_memory',
      'edit_memory',
      'delete_memory',
      'apply_patch_memory',
      'apply_patch',
      'delete_file',
      'exec',
      'get_memory_context',
      'create_child_session',
      'create_agent',
      'create_session',
      'set_agent_inherit',
      'send_to_session',
      'wait',
      'submit_compact_plan',
      'session',
      'skill',
      'get_session_messages',
      'get_archived_messages',
      'get_archived_blocks',
      'recall',
      'delete_session',
      'set_session_child_model',
      'set_session_compact_threshold',
      'stop_session',
      'compact_session',
      'browse_open',
      'browse_list',
      'browse_get',
      'browse_close',
      'browse_interact',
      'search_tools',
      'call_tool',
      'copy_between_nodes',
    ]);
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
      lastActivity: Date.now()
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
      lastActivity: Date.now()
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
  registerNodeWithTools(ws: WebSocket, _req: http.IncomingMessage, nodeType: string, capabilities: NodeCapabilities, customNodeId?: string): string {
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
      lastActivity: Date.now()
    };
    
    this.nodes.set(nodeId, node);
    logger.info({ nodeId, nodeType, toolCount: toolNames.size }, 'Node registered with capabilities');
    
    // Send node ID to the node
    ws.send(JSON.stringify({
      type: 'registered',
      nodeId: nodeId,
      status: 'success'
    }));
    
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
    const session = await sessionManager.getSession(sessionId);
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
    
    logger.info({ sessionId, nodeId }, 'Current node validated');
  }

  /**
   * Get node by ID
   */
  getNode(nodeId: string): Node | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * List all nodes
   */
  listNodes(): Array<{ id: string; lastActivity: number }> {
    return Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      lastActivity: node.lastActivity
    }));
  }

  /**
   * List all nodes with their tool capabilities
   */
  listNodesWithTools(): Array<{ id: string; type: string; tools: ToolDefinition[] }> {
    return Array.from(this.nodes.values())
      .filter((node) => node.type !== 'master' && node.capabilities)
      .map((node) => ({
        id: node.id,
        type: node.type,
        tools: node.capabilities?.tools || []
      }));
  }

  listNodeServiceSummaries(): Array<{ id: string; type: string; services: Record<string, number>; lastActivity: number }> {
    return Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      type: node.type,
      services: { ...(node.capabilities?.services || {}) },
      lastActivity: node.lastActivity,
    }));
  }

  listNodeIdsWithService(service: string): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.id !== 'master' && !!node.ws && Number(node.capabilities?.services?.[service] || 0) >= 1)
      .map((node) => node.id);
  }

  onNodeServiceEvent(listener: (event: NodeServiceEvent) => void): () => void {
    this.serviceEventListeners.add(listener);
    return () => this.serviceEventListeners.delete(listener);
  }

  handleNodeServiceEvent(nodeId: string, service: string, event: any): void {
    const node = this.nodes.get(nodeId);
    if (!node || Number(node.capabilities?.services?.[service] || 0) < 1) {
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

    const session = await sessionManager.getSession(sessionId);
    
    if (!node.tools.has(toolName)) {
      throw new Error(`Tool \`${toolName}\` not available on node \`${nodeId}\``);
    }
    
    // If master node, execute locally
    if (nodeId === 'master') {
      return await this.executeToolLocally(toolName, args, sessionId);
    }
    
    // Execute on remote node via WebSocket
    const callId = `call_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    
    return new Promise((resolve, reject) => {
      const toolCall: ToolCall = {
        id: callId,
        name: toolName,
        args,
        sessionId,
        node: nodeId,
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

      node.ws!.send(JSON.stringify({
        type: 'tool_call',
        callId: callId,
        tool: toolName,
        args: args,
        sessionId,
        agentName: session.agent || 'main',
        timeoutMs,
        ...(shouldSendCwd ? { sessionCwd: routedCwd } : {}),
      }));
      
      // Set timeout
      setTimeout(() => {
        if (this.toolCalls.has(callId)) {
          this.toolCalls.delete(callId);
          reject(`Tool call \`${callId}\` timed out`);
        }
      }, timeoutMs);
    });
  }

  /**
   * Handle tool response from node
   */
  handleToolResponse(callId: string, result: any): void {
    const call = this.toolCalls.get(callId);
    if (call) {
      this.toolCalls.delete(callId);
      call.resolve(adaptLegacyRemoteNodeToolResult(result));
      logger.info({ callId, tool: call.name }, 'Tool response received');
    } else {
      logger.warn({ callId }, 'Tool response for unknown call');
    }
  }

  /**
   * Handle tool error from node
   */
  handleToolError(callId: string, error: string): void {
    const call = this.toolCalls.get(callId);
    if (call) {
      this.toolCalls.delete(callId);
      call.reject(error);
      logger.warn({ callId, tool: call.name, error }, 'Tool error received');
    } else {
      logger.warn({ callId }, 'Tool error for unknown call');
    }
  }

  async readFileFromNode(nodeId: string, filePath: string, sessionId: string): Promise<NodeTransferFilePayload> {
    const session = await sessionManager.getSession(sessionId);
    const agentName = session.agent || 'main';
    const restrictToAgentDir = sessionManager.isSessionEffectivelyIsolated(session) && nodeId === 'master';

    if (nodeId === 'master') {
      return await readNodeTransferFile(filePath, agentName, restrictToAgentDir);
    }

    const node = this.nodes.get(nodeId);
    if (!node?.ws) {
      throw new Error(`Node \`${nodeId}\` not found`);
    }

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
    const session = await sessionManager.getSession(sessionId);
    const agentName = session.agent || 'main';
    const restrictToAgentDir = sessionManager.isSessionEffectivelyIsolated(session) && nodeId === 'master';

    if (nodeId === 'master') {
      return await writeNodeTransferFile(filePath, agentName, dataBase64, overwrite, restrictToAgentDir);
    }

    const node = this.nodes.get(nodeId);
    if (!node?.ws) {
      throw new Error(`Node \`${nodeId}\` not found`);
    }

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
    const session = await sessionManager.getExistingSession(sessionId);
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
    const session = await sessionManager.getExistingSession(sessionId);
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
      messageCount: session.meta?.messageCount || session.history?.length || 0,
      lastMessageTime: session.meta?.lastMessageTime || null,
      currentNode: session.currentNode,
      cwd: session.cwd,
      busy: session.busy,
      queueLength: session.queue?.length || 0,
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
    const summaries = [];
    for (const item of sessionManager.listSessions()) {
      const session = await sessionManager.getExistingSession(item.id);
      if (session && this.nodeCanAccessSession(nodeId, session)) {
        summaries.push(this.summarizeSession(session));
      }
    }
    return summaries;
  }

  async getSessionHistoryForNode(nodeId: string, sessionId: string, count = 30) {
    const session = await this.assertNodeCanAccessSession(nodeId, sessionId, 'read history for');
    const totalMessages = session.history?.length || 0;
    const safeCount = Math.max(1, Math.min(100, Number(count) || 30));
    const start = Math.max(0, totalMessages - safeCount);
    const messages = await sessionManager.getSessionMessages(session.id, start, safeCount);
    return {
      session: this.summarizeSession(session),
      totalMessages,
      messages: messages.map((message, offset) => this.serializeSessionMessage(message, start + offset)),
    };
  }

  async handleSessionEvent(nodeId: string, sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
    await this.assertNodeOwnsSessionForEvent(nodeId, sessionId);
    await sessionManager.queueSessionSystemEvent(sessionId, message, type);
    logger.info({ nodeId, sessionId, type }, 'Session event received from remote node');
  }

  async handleSessionUserMessage(nodeId: string, sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'trigger'): Promise<void> {
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
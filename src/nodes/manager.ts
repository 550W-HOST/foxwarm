/**
 * Nodes Manager - Manages remote nodes for distributed tool execution
 * Each node is a WebSocket connection that can execute tools
 */

import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { logger } from '../common';
import { WORKSPACE_DIR } from '../config';
import * as sessionManager from '../sessionManager';
import * as browser from '../browser';
import { WebSocket } from 'ws';
import { isReservedNodeId } from './registry';

interface ToolDefinition {
  name: string;
  description: string;
  parameters?: any;
}

interface NodeCapabilities {
  tools: ToolDefinition[];
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

export class NodesManager {
  private nodes: Map<string, Node> = new Map();
  private toolCalls: Map<string, ToolCall> = new Map();
  private tools: Set<string> = new Set(); // Available tools
  
  private readonly WORKSPACE = WORKSPACE_DIR;
  
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
      'apply_patch',
      'exec',
      'search_memory',
      'get_memory_context',
      'create_child_session',
      'create_agent',
      'create_session',
      'set_agent_inherit',
      'send_to_session',
      'list_sessions',
      'list_skills',
      'attach_agent_skill',
      'detach_agent_skill',
      'load_skill',
      'get_session_messages',
      'get_archived_messages',
      'delete_session',
      'update_session_name',
      'set_session_compact_threshold',
      'stop_session',
      'compact_session',
      'compress_session',
      'browse_open',
      'browse_list',
      'browse_get',
      'browse_close',
      'browse_interact'
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
  registerNode(ws: WebSocket, req: http.IncomingMessage, customNodeId?: string): string {
    if (customNodeId && isReservedNodeId(customNodeId)) {
      throw new Error(`Node id \`${customNodeId}\` is reserved`);
    }
    const nodeId = customNodeId || `node_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    
    // Check if node already exists (reconnection case)
    const existingNode = this.nodes.get(nodeId);
    if (existingNode && existingNode.ws) {
      logger.info({ nodeId }, 'Node reconnecting, closing old connection');
      existingNode.ws.close();
      this.nodes.delete(nodeId);
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
  registerNodeWithTools(ws: WebSocket, req: http.IncomingMessage, nodeType: string, capabilities: NodeCapabilities, customNodeId?: string): string {
    if (customNodeId && isReservedNodeId(customNodeId)) {
      throw new Error(`Node id \`${customNodeId}\` is reserved`);
    }
    const nodeId = customNodeId || `node_${Date.now()}_${crypto.randomBytes(4).toString('hex').substring(0, 8)}`;
    
    // Check if node already exists (reconnection case)
    const existingNode = this.nodes.get(nodeId);
    if (existingNode && existingNode.ws) {
      logger.info({ nodeId }, 'Node reconnecting, closing old connection');
      existingNode.ws.close();
      this.nodes.delete(nodeId);
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
  unregisterNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      this.nodes.delete(nodeId);
      logger.info({ nodeId }, 'Node unregistered');
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
    return Array.from(this.nodes.entries()).map(([id, node]) => ({
      id: node.id,
      lastActivity: node.lastActivity
    }));
  }

  /**
   * List all nodes with their tool capabilities
   */
  listNodesWithTools(): Array<{ id: string; type: string; tools: ToolDefinition[] }> {
    return Array.from(this.nodes.entries())
      .filter(([id, node]) => node.type !== 'master' && node.capabilities)
      .map(([id, node]) => ({
        id: node.id,
        type: node.type,
        tools: node.capabilities?.tools || []
      }));
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
  async executeTool(nodeId: string, toolName: string, args: Record<string, any>, sessionId: string): Promise<any> {
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
      node.ws!.send(JSON.stringify({
        type: 'tool_call',
        callId: callId,
        tool: toolName,
        args: args,
        sessionId,
        agentName: session.agent || 'main'
      }));
      
      // Set timeout (30 seconds default)
      setTimeout(() => {
        if (this.toolCalls.has(callId)) {
          this.toolCalls.delete(callId);
          reject(`Tool call \`${callId}\` timed out`);
        }
      }, 30000);
    });
  }

  /**
   * Handle tool response from node
   */
  handleToolResponse(callId: string, result: any): void {
    const call = this.toolCalls.get(callId);
    if (call) {
      this.toolCalls.delete(callId);
      call.resolve(result);
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

  async handleSessionEvent(sessionId: string, message: string, type: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
    await sessionManager.queueSessionSystemEvent(sessionId, message, type);
    logger.info({ sessionId, type }, 'Session event received from remote node');
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
    const toolsModule = require('./tools');
    const definitions = toolsModule.definitions;
    
    return definitions.find((d: any) => d.name === toolName);
  }

  /**
   * Execute a tool locally (on master node)
   */
  async executeToolLocally(toolName: string, args: Record<string, any>, sessionId: string): Promise<any> {
    // Keep lazy require here to avoid a real circular dependency:
    // tools -> nodesManager -> tools.
    const toolsModule = require('./tools');
    const tool = toolsModule[toolName];
    
    if (!tool) {
      throw new Error(`Tool \`${toolName}\` not found`);
    }
    
    const ctx = {
      sessionId,
      session: await sessionManager.getSession(sessionId),
      runtimeNodeId: 'master',
      broadcast: async (text: string) => {
        // Broadcast via session
        const session = await sessionManager.getSession(sessionId);
        if (session.broadcast) {
          await session.broadcast(text);
        }
      }
    };
    
    return await tool(args, ctx);
  }
}

// Create singleton instance
export const nodesManager = new NodesManager();
/**
 * Node Client - Connect to foxwarm master and execute tools
 * Usage: npm run node -- --host http://master:3001/ --id my-node --token <pairing-token>
 */

import fs from 'fs-extra';
import path from 'path';
import WebSocket from 'ws';
import { logger } from '../common';
import * as tools from '../tools';
import { initializeExecManager } from '../execManager';
import { readNodeTransferFile, writeNodeTransferFile } from '../nodeFileTransfer';

interface NodeClientOptions {
  host: string;
  nodeId?: string;
  token?: string;
  authToken?: string;
  credentialsFile?: string;
}

type StoredNodeCredentials = {
  nodeId: string;
  authToken: string;
  pairedAt: number;
}

const NODE_CAPABILITIES = {
  tools: [
    {
      name: 'read',
      description: 'Read a file from agent-folder.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          node: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' }
        },
        required: ['filePath']
      }
    },
    {
      name: 'write',
      description: 'Write a file to agent-folder.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' }
        },
        required: ['filePath', 'content']
      }
    },
    {
      name: 'edit',
      description: 'Replace exact text in a file using oldText/newText.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
          node: { type: 'string' }
        },
        required: ['filePath', 'oldText', 'newText']
      }
    },
    {
      name: 'apply_patch',
      description: 'Apply an OpenAI-style patch envelope to modify files.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          node: { type: 'string' }
        },
        required: ['input']
      }
    },
    {
      name: 'exec',
      description: 'Execute a shell command in agent-folder. Commands running over 15 seconds time out, continue in the background, and send a completion message later.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    },
    {
      name: 'browse_open',
      description: 'Open a new browser tab and navigate to URL. Returns tab ID for future operations.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          node: { type: 'string' }
        },
        required: ['url']
      }
    },
    {
      name: 'browse_list',
      description: 'List all open browser tabs with their IDs, titles, and URLs.',
      parameters: {
        type: 'object',
        properties: {
          node: { type: 'string' }
        }
      }
    },
    {
      name: 'browse_get',
      description: 'Get content or screenshot from a browser tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          node: { type: 'string' },
          screenshot: { type: ['boolean', 'string'], default: false }
        },
        required: ['tabId']
      }
    },
    {
      name: 'browse_close',
      description: 'Close a browser tab.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          node: { type: 'string' }
        },
        required: ['tabId']
      }
    },
    {
      name: 'browse_interact',
      description: 'Interact with a browser tab. Supports: click, type, fill, press, scroll, wait, evaluate, goto, back, forward, reload.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          action: {
            type: 'string',
            enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload']
          },
          node: { type: 'string' },
          params: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              text: { type: 'string' },
              key: { type: 'string' },
              y: { type: 'number' },
              url: { type: 'string' },
              code: { type: 'string' },
              timeout: { type: 'number' }
            }
          }
        },
        required: ['tabId', 'action']
      }
    }
  ]
};

class NodeClient {
  private ws: WebSocket | null = null;
  private host: string;
  private requestedName: string;
  private pairingToken?: string;
  private credentialsFile?: string;
  private connectedNodeId: string | null = null;
  private authToken?: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 5000; // 5 seconds
  private forceImmediateReconnect = false;
  private pairingRejected = false;

  constructor(options: NodeClientOptions) {
    this.host = options.host;
    this.requestedName = options.nodeId || `node_${Date.now()}`;
    this.pairingToken = options.token;
    this.credentialsFile = options.credentialsFile;
    this.connectedNodeId = options.authToken && options.nodeId ? options.nodeId : null;
    this.authToken = options.authToken;
  }

  private get isAuthenticatedMode(): boolean {
    return !!(this.connectedNodeId && this.authToken);
  }

  private async loadStoredCredentials(): Promise<void> {
    if (!this.credentialsFile || !await fs.pathExists(this.credentialsFile)) {
      return;
    }

    const stored = await fs.readJSON(this.credentialsFile) as StoredNodeCredentials;
    if (stored?.nodeId && stored?.authToken) {
      this.connectedNodeId = stored.nodeId;
      this.authToken = stored.authToken;
    }
  }

  private async saveStoredCredentials(nodeId: string, authToken: string): Promise<void> {
    if (!this.credentialsFile) {
      return;
    }

    await fs.ensureDir(path.dirname(this.credentialsFile));
    await fs.writeJSON(this.credentialsFile, {
      nodeId,
      authToken,
      pairedAt: Date.now(),
    }, { spaces: 2 });
  }

  private async clearStoredCredentials(): Promise<void> {
    this.connectedNodeId = null;
    this.authToken = undefined;
    if (this.credentialsFile && await fs.pathExists(this.credentialsFile)) {
      await fs.remove(this.credentialsFile);
    }
  }

  async connect(): Promise<void> {
    await this.loadStoredCredentials();

    if (!this.isAuthenticatedMode && !this.pairingToken) {
      throw new Error('Node client needs either stored/auth credentials or a pairing token');
    }

    const wsUrl = this.isAuthenticatedMode
      ? this.host.replace(/^http/, 'ws') + `/node_ws?id=${encodeURIComponent(String(this.connectedNodeId))}&auth=${encodeURIComponent(String(this.authToken))}`
      : this.host.replace(/^http/, 'ws') + `/node_ws?token=${encodeURIComponent(String(this.pairingToken))}`;

    logger.info({ host: this.host, nodeId: this.connectedNodeId, requestedName: this.requestedName, mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing' }, 'Connecting to foxwarm master...');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      logger.info({ nodeId: this.connectedNodeId, mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing' }, 'Connected to foxwarm master');

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (this.isAuthenticatedMode) {
        this.send({
          type: 'node_register',
          nodeType: 'sandbox',
          capabilities: NODE_CAPABILITIES
        });
      } else {
        this.send({
          type: 'pair_request',
          requestedName: this.requestedName,
          nodeType: 'sandbox',
          capabilities: NODE_CAPABILITIES,
        });
      }
    });

    this.ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (e) {
        logger.error({ err: e }, 'Error handling message from master');
      }
    });

    this.ws.on('close', async (code: number, reason: Buffer) => {
      const reasonText = reason.toString();
      logger.warn({ code, reason: reasonText }, 'Disconnected from master');
      if (this.pairingRejected) {
        logger.warn('Pairing was rejected; not reconnecting automatically');
        return;
      }
      if (code === 1008 && reasonText.includes('Invalid node credentials') && this.pairingToken) {
        logger.warn('Clearing stored node credentials after auth failure; falling back to pairing token');
        await this.clearStoredCredentials();
      }
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = this.forceImmediateReconnect ? 250 : this.reconnectDelay;
    this.forceImmediateReconnect = false;
    logger.info({ delay }, 'Scheduling reconnect...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        logger.error({ err }, 'Reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'registered':
        logger.info({ nodeId: message.nodeId }, 'Node registered');
        this.connectedNodeId = message.nodeId;
        break;
      case 'pair_pending':
        logger.info({ pendingId: message.pendingId, pairCode: message.pairCode, requestedName: message.requestedName }, 'Node pairing pending approval');
        break;
      case 'pair_approved':
        logger.info({ nodeId: message.nodeId }, 'Node pairing approved, storing credentials');
        await this.saveStoredCredentials(String(message.nodeId), String(message.authToken));
        this.connectedNodeId = String(message.nodeId);
        this.authToken = String(message.authToken);
        this.forceImmediateReconnect = true;
        this.ws?.close(1000, 'Reconnect with node credentials');
        break;
      case 'pair_rejected':
        logger.warn({ pendingId: message.pendingId, reason: message.reason }, 'Node pairing rejected');
        this.pairingRejected = true;
        break;
      case 'tool_call':
        await this.handleToolCall(message);
        break;
      case 'file_read_request':
        await this.handleFileReadRequest(message);
        break;
      case 'file_write_request':
        await this.handleFileWriteRequest(message);
        break;
      default:
        logger.warn({ type: message.type }, 'Unknown message type from master');
    }
  }

  private async handleFileReadRequest(message: any): Promise<void> {
    const transferId = String(message.transferId || '');
    const filePath = String(message.filePath || '');
    const agentName = typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName
      : 'main';

    try {
      const file = await readNodeTransferFile(filePath, agentName);
      this.send({
        type: 'file_read_response',
        transferId,
        file,
      });
    } catch (e: any) {
      this.send({
        type: 'file_transfer_error',
        transferId,
        error: e.message || String(e),
      });
    }
  }

  private async handleFileWriteRequest(message: any): Promise<void> {
    const transferId = String(message.transferId || '');
    const filePath = String(message.filePath || '');
    const agentName = typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName
      : 'main';

    try {
      const result = await writeNodeTransferFile(filePath, agentName, String(message.dataBase64 || ''), message.overwrite === true);
      this.send({
        type: 'file_write_response',
        transferId,
        result,
      });
    } catch (e: any) {
      this.send({
        type: 'file_transfer_error',
        transferId,
        error: e.message || String(e),
      });
    }
  }

  private async handleToolCall(message: any): Promise<void> {
    const { callId, tool, args } = message;
    const sessionId = typeof message.sessionId === 'string'
      ? message.sessionId
      : (typeof args?.sessionId === 'string' ? args.sessionId : 'node');
    const agentName = typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName
      : 'main';

    logger.info({ callId, tool }, 'Executing tool');

    try {
      const toolFn = (tools as any)[tool];
      if (!toolFn) {
        throw new Error(`Tool \`${tool}\` not found`);
      }

      const ctx = {
        sessionId,
        session: {
          id: sessionId,
          agent: agentName,
          currentNode: this.connectedNodeId || this.requestedName,
        },
        runtimeNodeId: this.connectedNodeId || this.requestedName,
        broadcast: async (text: string) => {
          this.send({
            type: 'broadcast',
            callId,
            text
          });
        },
        queueSystemEvent: async (text: string, eventType: 'background' | 'trigger' | 'onboot' = 'background') => {
          await this.sendSessionEvent(sessionId, text, eventType);
        }
      };

      const rawResult = await toolFn(args, ctx);
      const result = this.normalizeToolResult(rawResult);

      this.send({
        type: 'tool_call_response',
        callId,
        result
      });

      logger.info({ callId, tool }, 'Tool executed successfully');
    } catch (e: any) {
      logger.error({ err: e, callId, tool }, 'Tool execution failed');

      this.send({
        type: 'tool_call_error',
        callId,
        error: e.message || String(e)
      });
    }
  }

  private normalizeToolResult(rawResult: any): any {
    if (rawResult === undefined) {
      return { output: '(No output)' };
    }

    if (rawResult === null) {
      return { output: null };
    }

    if (typeof rawResult === 'string' || typeof rawResult === 'number' || typeof rawResult === 'boolean') {
      return { output: rawResult };
    }

    if (typeof rawResult === 'object') {
      return rawResult;
    }

    return { output: String(rawResult) };
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      logger.warn('Cannot send message: WebSocket not connected');
    }
  }

  async sendSessionEvent(sessionId: string, message: string, eventType: 'background' | 'trigger' | 'onboot' = 'background'): Promise<void> {
    if (!sessionId) {
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Remote node is not connected to master');
    }

    this.send({
      type: 'session_event',
      sessionId,
      eventType,
      message,
    });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

function parseArgs(): NodeClientOptions {
  const args = process.argv.slice(2);
  const options: any = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--host' && i + 1 < args.length) {
      options.host = args[++i];
    } else if (arg === '--id' && i + 1 < args.length) {
      options.nodeId = args[++i];
    } else if (arg === '--token' && i + 1 < args.length) {
      options.token = args[++i];
    } else if (arg === '--auth-token' && i + 1 < args.length) {
      options.authToken = args[++i];
    } else if (arg === '--credentials-file' && i + 1 < args.length) {
      options.credentialsFile = args[++i];
    }
  }

  if (!options.host) {
    console.error('Error: --host is required');
    console.error('Usage: npm run node -- --host http://master:3001/ --id requested-name --token <pairing-token> [--credentials-file path]');
    process.exit(1);
  }

  if (!options.token && !(options.authToken && options.nodeId) && !options.credentialsFile) {
    console.error('Error: provide --token, or (--auth-token with --id), or --credentials-file with stored node credentials');
    process.exit(1);
  }

  return options as NodeClientOptions;
}

async function main() {
  const options = parseArgs();
  const client = new NodeClient(options);

  await initializeExecManager({
    completionDispatcher: async (entry, _status, message) => {
      if (!entry.sessionId) {
        return;
      }
      await client.sendSessionEvent(entry.sessionId, message, 'background');
    }
  });

  await client.connect();

  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await client.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await client.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error({ err }, 'Node client failed');
  process.exit(1);
});

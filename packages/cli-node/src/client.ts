#!/usr/bin/env node
/**
 * Node Client - Connect to foxwarm master and execute tools
 * Usage: cli-node-client --host http://master:3001/ --id my-node --token <pairing-token>
 */

import crypto from 'crypto';
import fs from 'fs-extra';
import http from 'http';
import path from 'path';
import WebSocket from 'ws';
import { nodeTools } from '../../shared/dist/nodeTools';
import { CLI_NODE_CAPABILITIES } from '../../shared/dist/nodeCapabilities';
import { readNodeTransferFile, writeNodeTransferFile } from '../../shared/dist/nodeFileTransfer';
import { executeVscodeNodeService, serializeVscodeNodeServiceError, VSCODE_NODE_SERVICE_VERSIONS, type VscodeNodeServiceName } from '../../shared/dist/vscodeNodeService';
import { createMasterWebSocketOptions, getMasterProxyInfo } from './masterProxy';

type LogPayload = Record<string, any> | Error | any;
const logger = {
  info: (payload?: LogPayload, message?: string) => logLine('info', payload, message),
  warn: (payload?: LogPayload, message?: string) => logLine('warn', payload, message),
  error: (payload?: LogPayload, message?: string) => logLine('error', payload, message),
};
function logLine(level: string, payload?: LogPayload, message?: string) {
  if (process.env.FOXWARM_NO_CONSOLE_LOG === '1') return;
  if (typeof payload === 'string' && message === undefined) {
    console.error(`[${level}] ${payload}`);
  } else {
    console.error(`[${level}] ${message || ''}`, payload || '');
  }
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CliNodeSessionSummary {
  id: string;
  displayName?: string;
  messageCount: number;
  lastMessageTime: number | null;
  currentNode?: string;
  cwd?: string;
  busy?: boolean;
  queueLength?: number;
}

export interface CliNodeHistoryMessage {
  index: number;
  role: string;
  text: string;
  timestamp?: number;
}

export interface NodeClientOptions {
  host: string;
  nodeId?: string;
  token?: string;
  authToken?: string;
  credentialsFile?: string;
  localTrigger?: boolean;
  localTriggerPort?: number;
  /** Optional hook called before each tool execution. Return false/'rejected'/'timeout' to reject. */
  toolCallInterceptor?: (tool: string, args: any, sessionId: string, callId: string, timeoutMs?: number) => Promise<boolean | string>;
  /** Optional status callback for UI integration */
  onStatus?: (event: string, detail?: Record<string, any>) => void;
}

type StoredNodeCredentials = {
  nodeId: string;
  authToken: string;
  pairedAt: number;
}

const NODE_CAPABILITIES = CLI_NODE_CAPABILITIES;


const DEFAULT_LOCAL_TRIGGER_HOST = '127.0.0.1';


const NODE_CLIENT_HEARTBEAT_INTERVAL_MS = 30_000;
const NODE_CLIENT_HEARTBEAT_TIMEOUT_MS = 10_000;

type LocalTriggerRuntime = {
  host: string;
  port: number;
  token: string;
  tokenFile: string;
  metaFile: string;
  scriptFile: string;
};

function resolveNodeStateDir(credentialsFile?: string): string {
  return credentialsFile
    ? path.dirname(path.resolve(credentialsFile))
    : path.resolve(process.cwd(), 'state');
}

function buildLocalTriggerPaths(stateDir: string) {
  return {
    tokenFile: path.join(stateDir, 'node_local_trigger_token'),
    metaFile: path.join(stateDir, 'node_local_trigger.json'),
    scriptFile: path.join(stateDir, 'trigger-session-event.sh'),
  };
}

function buildLocalTriggerScript(metaFile: string, tokenFile: string): string {
  return `#!/bin/sh
set -eu
META_FILE="${metaFile}"
TOKEN_FILE="${tokenFile}"
if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <session-id> <message> [event-type]" >&2
  exit 1
fi
SESSION_ID="$1"
MESSAGE="$2"
EVENT_TYPE="\${3:-trigger}"
python3 - "$META_FILE" "$TOKEN_FILE" "$SESSION_ID" "$MESSAGE" "$EVENT_TYPE" <<'PY'
import json, sys, urllib.request
meta_path, token_path, session_id, message, event_type = sys.argv[1:]
with open(meta_path, 'r', encoding='utf-8') as f:
    meta = json.load(f)
with open(token_path, 'r', encoding='utf-8') as f:
    token = f.read().strip()
req = urllib.request.Request(
    f"http://{meta['host']}:{meta['port']}/trigger" ,
    data=json.dumps({
        'sessionId': session_id,
        'message': message,
        'eventType': event_type,
    }).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {token}',
    },
    method='POST',
)
with urllib.request.urlopen(req) as resp:
    sys.stdout.write(resp.read().decode('utf-8'))
PY
`;
}

export class NodeClient {
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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private heartbeatAwaitingPong = false;
  private heartbeatLastPingAt = 0;
  private pairingRejected = false;
  private localTriggerEnabled = true;
  private localTriggerPort = 0;
  private localTriggerServer: http.Server | null = null;
  private localTriggerRuntime: LocalTriggerRuntime | null = null;
  private toolCallInterceptor?: (tool: string, args: any, sessionId: string, callId: string, timeoutMs?: number) => Promise<boolean | string>;
  private onStatus?: (event: string, detail?: Record<string, any>) => void;
  private pendingRequests: Map<string, PendingRequest> = new Map();

  constructor(options: NodeClientOptions) {
    this.host = options.host;
    this.requestedName = options.nodeId || `node_${Date.now()}`;
    this.pairingToken = options.token;
    this.credentialsFile = options.credentialsFile;
    this.connectedNodeId = options.authToken && options.nodeId ? options.nodeId : null;
    this.authToken = options.authToken;
    this.localTriggerEnabled = options.localTrigger !== false;
    this.localTriggerPort = typeof options.localTriggerPort === 'number' && Number.isFinite(options.localTriggerPort)
      ? options.localTriggerPort
      : 0;
    this.toolCallInterceptor = options.toolCallInterceptor;
    this.onStatus = options.onStatus;
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

  private async ensureLocalTriggerRuntime(): Promise<LocalTriggerRuntime> {
    if (this.localTriggerRuntime) {
      return this.localTriggerRuntime;
    }

    const stateDir = resolveNodeStateDir(this.credentialsFile);
    const { tokenFile, metaFile, scriptFile } = buildLocalTriggerPaths(stateDir);
    await fs.ensureDir(stateDir);

    let token: string;
    if (await fs.pathExists(tokenFile)) {
      token = String(await fs.readFile(tokenFile, 'utf8')).trim();
    } else {
      token = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    }

    this.localTriggerRuntime = {
      host: DEFAULT_LOCAL_TRIGGER_HOST,
      port: this.localTriggerPort,
      token,
      tokenFile,
      metaFile,
      scriptFile,
    };
    return this.localTriggerRuntime;
  }

  private async writeLocalTriggerArtifacts(runtime: LocalTriggerRuntime): Promise<void> {
    await fs.writeJson(runtime.metaFile, {
      host: runtime.host,
      port: runtime.port,
      tokenFile: runtime.tokenFile,
      scriptFile: runtime.scriptFile,
      nodeId: this.connectedNodeId,
    }, { spaces: 2 });
    await fs.writeFile(runtime.scriptFile, buildLocalTriggerScript(runtime.metaFile, runtime.tokenFile), { mode: 0o700 });
  }

  async startLocalTriggerServer(): Promise<void> {
    if (!this.localTriggerEnabled || this.localTriggerServer) {
      return;
    }

    const runtime = await this.ensureLocalTriggerRuntime();
    this.localTriggerServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
        if (url.pathname !== '/trigger') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }

        const authHeader = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
        const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
        const headerToken = Array.isArray(req.headers['x-node-trigger-token']) ? req.headers['x-node-trigger-token'][0] : req.headers['x-node-trigger-token'];
        const providedToken = bearer || headerToken;
        if (providedToken !== runtime.token) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : '';
        const message = typeof body.message === 'string' && body.message.trim() ? body.message : '';
        const eventType = body.eventType === 'background' || body.eventType === 'onboot' ? body.eventType : 'trigger';

        if (!sessionId || !message) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'sessionId and message are required' }));
          return;
        }

        await this.sendSessionEvent(sessionId, message, eventType);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        logger.warn({ err }, 'Local node trigger request failed');
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.localTriggerServer!.once('error', reject);
      this.localTriggerServer!.listen(runtime.port, runtime.host, () => resolve());
    });
    const address = this.localTriggerServer.address();
    if (address && typeof address === 'object') {
      runtime.port = address.port;
    }
    await this.writeLocalTriggerArtifacts(runtime);
    logger.info({ host: runtime.host, port: runtime.port, tokenFile: runtime.tokenFile, scriptFile: runtime.scriptFile }, 'Node local trigger endpoint ready');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.heartbeatAwaitingPong = false;
    this.heartbeatLastPingAt = 0;
  }

  private markHeartbeatAlive(): void {
    this.heartbeatAwaitingPong = false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (this.heartbeatAwaitingPong && Date.now() - this.heartbeatLastPingAt >= NODE_CLIENT_HEARTBEAT_TIMEOUT_MS) {
        logger.warn({ nodeId: this.connectedNodeId || this.requestedName }, 'Master heartbeat timed out; terminating stale node client socket');
        try {
          this.ws.terminate();
        } catch (err) {
          logger.warn({ err, nodeId: this.connectedNodeId || this.requestedName }, 'Failed to terminate stale node client socket');
        }
        return;
      }
      try {
        this.heartbeatAwaitingPong = true;
        this.heartbeatLastPingAt = Date.now();
        this.ws.ping();
      } catch (err) {
        logger.warn({ err, nodeId: this.connectedNodeId || this.requestedName }, 'Failed to send node client heartbeat ping');
      }
    }, NODE_CLIENT_HEARTBEAT_INTERVAL_MS);
    this.heartbeatInterval.unref?.();
  }

  private async stopLocalTriggerServer(): Promise<void> {
    if (!this.localTriggerServer) {
      return;
    }
    const server = this.localTriggerServer;
    this.localTriggerServer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async connect(): Promise<void> {
    await this.loadStoredCredentials();

    if (!this.isAuthenticatedMode && !this.pairingToken) {
      throw new Error('Node client needs either stored/auth credentials or a pairing token');
    }

    const wsUrl = this.isAuthenticatedMode
      ? this.host.replace(/^http/, 'ws') + `/node_ws?id=${encodeURIComponent(String(this.connectedNodeId))}&auth=${encodeURIComponent(String(this.authToken))}`
      : this.host.replace(/^http/, 'ws') + `/node_ws?token=${encodeURIComponent(String(this.pairingToken))}`;

    const proxyInfo = getMasterProxyInfo(wsUrl);
    logger.info({
      host: this.host,
      nodeId: this.connectedNodeId,
      requestedName: this.requestedName,
      mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing',
      proxy: proxyInfo?.sanitizedProxyUrl,
    }, 'Connecting to foxwarm master...');
    this.onStatus?.('connecting', { mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing' });

    this.ws = new WebSocket(wsUrl, createMasterWebSocketOptions(wsUrl));

    this.ws.on('open', () => {
      logger.info({ nodeId: this.connectedNodeId, mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing' }, 'Connected to foxwarm master');
      this.onStatus?.('connected', { mode: this.isAuthenticatedMode ? 'authenticated' : 'pairing' });

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.startHeartbeat();

      if (this.isAuthenticatedMode) {
        this.send({
          type: 'node_register',
          nodeType: 'cli-node',
          capabilities: NODE_CAPABILITIES
        });
      } else {
        this.send({
          type: 'pair_request',
          requestedName: this.requestedName,
          nodeType: 'cli-node',
          capabilities: NODE_CAPABILITIES,
        });
      }
    });

    this.ws.on('message', async (data: Buffer) => {
      this.markHeartbeatAlive();
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (e) {
        logger.error({ err: e }, 'Error handling message from master');
      }
    });

    this.ws.on('pong', () => {
      this.markHeartbeatAlive();
    });

    this.ws.on('close', async (code: number, reason: Buffer) => {
      this.stopHeartbeat();
      const reasonText = reason.toString();
      logger.warn({ code, reason: reasonText }, 'Disconnected from master');
      this.onStatus?.('disconnected', { code, reason: reasonText });
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
      this.stopHeartbeat();
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
    this.onStatus?.('reconnecting', { delay });
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
        this.onStatus?.('registered', { nodeId: message.nodeId });
        this.connectedNodeId = message.nodeId;
        if (this.localTriggerRuntime) {
          await this.writeLocalTriggerArtifacts(this.localTriggerRuntime);
        }
        break;
      case 'pair_pending':
        logger.info({ pendingId: message.pendingId, pairCode: message.pairCode, requestedName: message.requestedName }, 'Node pairing pending approval');
        this.onStatus?.('pair_pending', { pendingId: message.pendingId, pairCode: message.pairCode });
        break;
      case 'pair_approved':
        logger.info({ nodeId: message.nodeId }, 'Node pairing approved, storing credentials');
        this.onStatus?.('pair_approved', { nodeId: message.nodeId });
        await this.saveStoredCredentials(String(message.nodeId), String(message.authToken));
        this.connectedNodeId = String(message.nodeId);
        this.authToken = String(message.authToken);
        if (this.localTriggerRuntime) {
          await this.writeLocalTriggerArtifacts(this.localTriggerRuntime);
        }
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
      case 'node_service_request':
        await this.handleNodeServiceRequest(message);
        break;
      case 'cli_response':
        this.handleCliResponse(message);
        break;
      case 'session_event_accepted':
        this.handleCliResponse({ type: 'cli_response', requestId: message.requestId, ok: true, result: { accepted: true } });
        break;
      case 'error':
        if (message.requestId) this.handleCliResponse({ type: 'cli_response', requestId: message.requestId, ok: false, error: message.error || 'Unknown error' });
        else logger.warn({ error: message.error }, 'Error from master');
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
      const file = await readNodeTransferFile(filePath, agentName, message.restrictToAgentDir === true);
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

  private async handleNodeServiceRequest(message: any): Promise<void> {
    const requestId = String(message.requestId || '');
    const service = String(message.service || '') as VscodeNodeServiceName;
    const operation = String(message.operation || '');
    try {
      if (!(service in VSCODE_NODE_SERVICE_VERSIONS)) {
        throw new Error(`Unsupported node service: ${service}`);
      }
      const result = await executeVscodeNodeService(service, operation, message.args && typeof message.args === 'object' ? message.args : {});
      this.send({ type: 'node_service_response', requestId, result });
    } catch (error) {
      this.send({ type: 'node_service_error', requestId, error: serializeVscodeNodeServiceError(error) });
    }
  }

  private async handleFileWriteRequest(message: any): Promise<void> {
    const transferId = String(message.transferId || '');
    const filePath = String(message.filePath || '');
    const agentName = typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName
      : 'main';

    try {
      const result = await writeNodeTransferFile(filePath, agentName, String(message.dataBase64 || ''), message.overwrite === true, message.restrictToAgentDir === true);
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
    const timeoutMs = typeof message.timeoutMs === 'number' ? message.timeoutMs : undefined;
    const sessionId = typeof message.sessionId === 'string'
      ? message.sessionId
      : (typeof args?.sessionId === 'string' ? args.sessionId : 'node');
    const agentName = typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName
      : 'main';

    logger.info({ callId, tool }, 'Executing tool');

    try {
      // Interceptor hook: allow external code to approve/reject before execution
      if (this.toolCallInterceptor) {
        const result = await this.toolCallInterceptor(tool, args, sessionId, callId, timeoutMs);
        if (result !== true) {
          const reason = typeof result === 'string' ? result : 'rejected';
          const errorMsg = reason === 'timeout'
            ? 'Tool call timed out waiting for user confirmation on interactive node. The user was not present to approve.'
            : 'Tool execution rejected by user on interactive node';
          this.send({
            type: 'tool_call_error',
            callId,
            error: errorMsg,
          });
          return;
        }
      }

      const toolFn = (nodeTools as any)[tool];
      if (!toolFn) {
        throw new Error(`Tool \`${tool}\` not found`);
      }

      const ctx = {
        sessionId,
        session: {
          id: sessionId,
          agent: agentName,
          currentNode: this.connectedNodeId || this.requestedName,
          cwd: typeof message.sessionCwd === 'string' ? message.sessionCwd : undefined,
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


  private handleCliResponse(message: any): void {
    const requestId = String(message.requestId || '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      logger.warn({ requestId }, 'Response for unknown cli-node request');
      return;
    }
    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    if (message.ok === false) {
      pending.reject(new Error(message.error || 'cli-node request failed'));
    } else {
      pending.resolve(message.result);
    }
  }

  private request(type: string, payload: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Remote node is not connected to master'));
    }
    const requestId = `cli_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`cli-node request ${type} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.send({ type, requestId, ...payload });
    });
  }

  async listBoundSessions(): Promise<CliNodeSessionSummary[]> {
    const result = await this.request('session_list_request');
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  async getSessionHistory(sessionId: string, count = 30): Promise<{ session: CliNodeSessionSummary; messages: CliNodeHistoryMessage[]; totalMessages: number }> {
    return await this.request('session_history_request', { sessionId, count });
  }

  async sendSessionMessage(sessionId: string, message: string): Promise<void> {
    await this.request('session_send_message', { sessionId, message, eventType: 'trigger' });
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await this.stopLocalTriggerServer();
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
    } else if (arg === '--local-trigger-port' && i + 1 < args.length) {
      options.localTriggerPort = Number(args[++i]);
    } else if (arg === '--no-local-trigger') {
      options.localTrigger = false;
    }
  }

  if (!options.host) {
    console.error('Error: --host is required');
    console.error('Usage: cli-node-client --host http://master:3001/ --id requested-name --token <pairing-token> [--credentials-file path] [--local-trigger-port <port>] [--no-local-trigger]');
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


  await client.startLocalTriggerServer();
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

function isClientCliEntrypoint(): boolean {
  const entryBase = process.argv[1] ? path.basename(process.argv[1]) : '';
  return entryBase === 'client.js'
    || entryBase === 'client.bundle.js'
    || entryBase === 'cli-node-client';
}

if (require.main === module && isClientCliEntrypoint()) {
  main().catch(err => {
    logger.error({ err }, 'Node client failed');
    process.exit(1);
  });
}

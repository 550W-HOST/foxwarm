import type { WebSocket } from 'ws';
import { WebSocket as WebSocketClass } from 'ws';
import {
  attachTerminalClient as attachLocalClient,
  closeTerminal as closeLocalTerminal,
  createTerminal as createLocalTerminal,
  detachTerminalClient as detachLocalClient,
  getTerminalRecord as getLocalTerminal,
  listTerminalRecords as listLocalTerminals,
  resizeTerminal as resizeLocalTerminal,
  resolveTerminalControlRequest as resolveLocalTerminalControlRequest,
  writeTerminalInput as writeLocalTerminalInput,
  type TerminalRecord,
} from './terminalManager';
import { nodesManager } from './nodes/manager';
import { logger } from './common';

const REMOTE_OUTPUT_BUFFER_LIMIT = 200_000;

type RemoteTerminal = {
  terminal: TerminalRecord;
  clients: Set<WebSocket>;
  codeControlClients: Set<WebSocket>;
  outputBuffer: string;
  attachedAtNode: boolean;
  controlOwner?: WebSocket;
};

const remoteTerminals = new Map<string, RemoteTerminal>();
const pendingRemoteCodeRequests = new Map<string, {
  requestId: string;
  terminalId: string;
  owner: WebSocket;
  timeout: NodeJS.Timeout;
}>();

function normalizeRemoteRecord(nodeId: string, value: any): TerminalRecord {
  if (!value || typeof value.id !== 'string' || !value.id) throw new Error('Remote terminal response is invalid.');
  return {
    id: value.id,
    nodeId,
    shell: typeof value.shell === 'string' ? value.shell : '',
    cwd: typeof value.cwd === 'string' ? value.cwd : '/',
    cols: Number(value.cols || 100),
    rows: Number(value.rows || 30),
    createdAt: Number(value.createdAt || Date.now()),
    pid: Number(value.pid || 0),
  };
}

function registerRemoteTerminal(nodeId: string, value: any): RemoteTerminal {
  const terminal = normalizeRemoteRecord(nodeId, value);
  const existing = remoteTerminals.get(terminal.id);
  if (existing) {
    existing.terminal = terminal;
    return existing;
  }
  const record: RemoteTerminal = { terminal, clients: new Set(), codeControlClients: new Set(), outputBuffer: '', attachedAtNode: false };
  remoteTerminals.set(terminal.id, record);
  return record;
}

function sendToClients(record: RemoteTerminal, payload: any): void {
  const encoded = JSON.stringify(payload);
  for (const client of record.clients) {
    if (client.readyState === WebSocketClass.OPEN) client.send(encoded);
  }
}

nodesManager.onNodeServiceEvent(({ nodeId, service, event }) => {
  if (service !== 'vscode-pty' || !event || typeof event !== 'object') return;
  if (event.type === 'node-unavailable') {
    for (const record of remoteTerminals.values()) {
      if (record.terminal.nodeId !== nodeId) continue;
      sendToClients(record, { type: 'error', message: event.reason || `Remote node ${nodeId} disconnected.` });
      for (const client of record.clients) {
        try { client.close(1011, 'Remote node disconnected'); } catch {}
      }
      record.clients.clear();
      record.codeControlClients.clear();
      record.controlOwner = undefined;
      record.attachedAtNode = false;
      for (const [key, pending] of pendingRemoteCodeRequests) {
        if (pending.terminalId !== record.terminal.id) continue;
        clearTimeout(pending.timeout);
        pendingRemoteCodeRequests.delete(key);
      }
    }
    return;
  }
  const terminalId = typeof event.terminalId === 'string' ? event.terminalId : '';
  const record = terminalId ? remoteTerminals.get(terminalId) : undefined;
  if (!record || record.terminal.nodeId !== nodeId) return;
  if (event.type === 'code-request' && typeof event.requestId === 'string') {
    const owner = record.controlOwner && record.controlOwner.readyState === WebSocketClass.OPEN
      ? record.controlOwner
      : [...record.codeControlClients].reverse().find((client) => client.readyState === WebSocketClass.OPEN);
    if (!owner) {
      try {
        nodesManager.sendNodeServiceCommand(nodeId, 'vscode-pty', 'code-result', {
          requestId: event.requestId,
          ok: false,
          error: 'No Code terminal is attached to handle this request.',
        });
      } catch {}
      return;
    }
    record.controlOwner = owner;
    const key = `${nodeId}\0${event.requestId}`;
    const timeout = setTimeout(() => pendingRemoteCodeRequests.delete(key), 21_000);
    pendingRemoteCodeRequests.set(key, { requestId: event.requestId, terminalId, owner, timeout });
    owner.send(JSON.stringify({
      type: 'control',
      requestId: event.requestId,
      command: 'open',
      request: { ...event.request, nodeId },
    }));
    return;
  }
  if (event.type === 'output' && typeof event.data === 'string') {
    record.outputBuffer += event.data;
    if (record.outputBuffer.length > REMOTE_OUTPUT_BUFFER_LIMIT) record.outputBuffer = record.outputBuffer.slice(-REMOTE_OUTPUT_BUFFER_LIMIT);
    sendToClients(record, { type: 'output', data: event.data });
    return;
  }
  if (event.type === 'exit') {
    if (typeof event.cwd === 'string' && event.cwd) record.terminal.cwd = event.cwd;
    sendToClients(record, { type: 'exit', exitCode: Number(event.exitCode || 0), signal: event.signal, cwd: event.cwd });
    for (const [key, pending] of pendingRemoteCodeRequests) {
      if (pending.terminalId !== terminalId) continue;
      clearTimeout(pending.timeout);
      pendingRemoteCodeRequests.delete(key);
    }
    remoteTerminals.delete(terminalId);
    return;
  }
  if (event.type === 'error') {
    sendToClients(record, { type: 'error', message: event.error?.message || `Remote terminal ${event.operation || 'operation'} failed.` });
  }
});

async function refreshRemoteTerminals(): Promise<TerminalRecord[]> {
  const nodeIds = nodesManager.listNodeIdsWithService('vscode-pty');
  const groups = await Promise.all(nodeIds.map(async (nodeId) => {
    try {
      const result = await nodesManager.requestNodeService(nodeId, 'vscode-pty', 'list', {});
      const values = Array.isArray(result?.terminals) ? result.terminals : [];
      return values.map((value: any) => registerRemoteTerminal(nodeId, value).terminal);
    } catch (error) {
      logger.warn({ err: error, nodeId }, 'Failed to list remote node terminals');
      return [];
    }
  }));
  return groups.flat();
}

async function findRemoteTerminal(terminalId: string): Promise<RemoteTerminal | null> {
  const existing = remoteTerminals.get(terminalId);
  if (existing) return existing;
  await refreshRemoteTerminals();
  return remoteTerminals.get(terminalId) || null;
}

export async function createTerminal(options: { cwd: string; nodeId?: string; cols?: number; rows?: number }): Promise<TerminalRecord> {
  const nodeId = options.nodeId || 'master';
  if (nodeId === 'master') return createLocalTerminal(options);
  const result = await nodesManager.requestNodeService(nodeId, 'vscode-pty', 'create', {
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
  });
  return registerRemoteTerminal(nodeId, result?.terminal).terminal;
}

export async function listTerminalRecords(): Promise<TerminalRecord[]> {
  const [local, remote] = await Promise.all([listLocalTerminals(), refreshRemoteTerminals()]);
  return [...local, ...remote].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getTerminalRecord(terminalId: string): Promise<TerminalRecord | null> {
  const local = await getLocalTerminal(terminalId);
  if (local) return local;
  const remote = await findRemoteTerminal(terminalId);
  if (!remote) return null;
  const result = await nodesManager.requestNodeService(remote.terminal.nodeId, 'vscode-pty', 'get', { terminalId });
  if (!result?.terminal) {
    remoteTerminals.delete(terminalId);
    return null;
  }
  return registerRemoteTerminal(remote.terminal.nodeId, result.terminal).terminal;
}

export async function attachTerminalClient(terminalId: string, client: WebSocket, options?: { codeControl?: boolean }): Promise<{ terminal: TerminalRecord; backlog: string }> {
  const local = await getLocalTerminal(terminalId);
  if (local) return attachLocalClient(terminalId, client, options);
  const record = await findRemoteTerminal(terminalId);
  if (!record) throw new Error(`Terminal not found: ${terminalId}`);
  record.clients.add(client);
  if (options?.codeControl) {
    record.codeControlClients.add(client);
    record.controlOwner = client;
  }
  if (!record.attachedAtNode) {
    try {
      const result = await nodesManager.requestNodeService(record.terminal.nodeId, 'vscode-pty', 'attach', { terminalId });
      record.terminal = normalizeRemoteRecord(record.terminal.nodeId, result?.terminal);
      record.outputBuffer = typeof result?.backlog === 'string' ? result.backlog : '';
      record.attachedAtNode = true;
    } catch (error) {
      record.clients.delete(client);
      record.codeControlClients.delete(client);
      if (record.controlOwner === client) record.controlOwner = undefined;
      throw error;
    }
  }
  return { terminal: record.terminal, backlog: record.outputBuffer };
}

export function detachTerminalClient(terminalId: string, client: WebSocket): void {
  const record = remoteTerminals.get(terminalId);
  if (!record) {
    detachLocalClient(terminalId, client);
    return;
  }
  record.clients.delete(client);
  record.codeControlClients.delete(client);
  for (const [key, pending] of pendingRemoteCodeRequests) {
    if (pending.terminalId !== terminalId || pending.owner !== client) continue;
    clearTimeout(pending.timeout);
    pendingRemoteCodeRequests.delete(key);
    try {
      nodesManager.sendNodeServiceCommand(record.terminal.nodeId, 'vscode-pty', 'code-result', {
        requestId: pending.requestId,
        ok: false,
        error: 'The Code terminal detached before handling the request.',
      });
    } catch {}
  }
  if (record.controlOwner === client) {
    record.controlOwner = [...record.codeControlClients].reverse().find((candidate) => candidate.readyState === WebSocketClass.OPEN);
  }
  if (record.clients.size === 0 && record.attachedAtNode) {
    record.attachedAtNode = false;
    try { nodesManager.sendNodeServiceCommand(record.terminal.nodeId, 'vscode-pty', 'detach', { terminalId }); } catch {}
  }
}

export function resolveTerminalControlRequest(terminalId: string, client: WebSocket, payload: any): void {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
  const record = remoteTerminals.get(terminalId);
  if (!record) {
    resolveLocalTerminalControlRequest(terminalId, client, payload);
    return;
  }
  const key = `${record.terminal.nodeId}\0${requestId}`;
  const pending = requestId ? pendingRemoteCodeRequests.get(key) : undefined;
  if (!pending) throw new Error('Unknown or unauthorized remote terminal control response.');
  if (pending.terminalId !== terminalId || pending.owner !== client) throw new Error('Unknown or unauthorized remote terminal control response.');
  pendingRemoteCodeRequests.delete(key);
  clearTimeout(pending.timeout);
  nodesManager.sendNodeServiceCommand(record.terminal.nodeId, 'vscode-pty', 'code-result', {
    requestId,
    ok: payload.ok === true,
    ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  });
}

export function writeTerminalInput(terminalId: string, data: string): void {
  const remote = remoteTerminals.get(terminalId);
  if (!remote) {
    writeLocalTerminalInput(terminalId, data);
    return;
  }
  nodesManager.sendNodeServiceCommand(remote.terminal.nodeId, 'vscode-pty', 'input', { terminalId, data });
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const remote = remoteTerminals.get(terminalId);
  if (!remote) {
    resizeLocalTerminal(terminalId, cols, rows);
    return;
  }
  remote.terminal.cols = Math.max(20, Math.floor(cols));
  remote.terminal.rows = Math.max(5, Math.floor(rows));
  nodesManager.sendNodeServiceCommand(remote.terminal.nodeId, 'vscode-pty', 'resize', { terminalId, cols, rows });
}

export async function closeTerminal(terminalId: string, reason = 'manual-close'): Promise<void> {
  const local = await getLocalTerminal(terminalId);
  if (local) {
    await closeLocalTerminal(terminalId, reason);
    return;
  }
  const remote = await findRemoteTerminal(terminalId);
  if (!remote) return;
  await nodesManager.requestNodeService(remote.terminal.nodeId, 'vscode-pty', 'close', { terminalId, reason });
  for (const [key, pending] of pendingRemoteCodeRequests) {
    if (pending.terminalId !== terminalId) continue;
    clearTimeout(pending.timeout);
    pendingRemoteCodeRequests.delete(key);
  }
  remoteTerminals.delete(terminalId);
  for (const client of remote.clients) {
    try { client.close(); } catch {}
  }
  remote.clients.clear();
  remote.codeControlClients.clear();
}
